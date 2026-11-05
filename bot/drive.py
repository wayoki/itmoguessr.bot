"""Read-only Google Drive API access for the location queue."""

import argparse
import asyncio
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Iterator
from urllib.parse import quote

from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import AuthorizedSession
from google.oauth2.credentials import Credentials
from google.oauth2.service_account import Credentials as ServiceCredentials
from requests import RequestException

logger = logging.getLogger(__name__)

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
FILES_URL = "https://www.googleapis.com/drive/v3/files"
FOLDER_MIME = "application/vnd.google-apps.folder"
REQUEST_TIMEOUT = (5, 20)
DOWNLOAD_TIMEOUT = 180
CHUNK_SIZE = 256 * 1024
NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)"
COORDINATES = re.compile(rf"\s*({NUMBER})\s*,\s*({NUMBER})\s*")
MEDIA_MIME = {
    "image/jpeg": "photo",
    "image/png": "photo",
    "video/mp4": "video",
    "image/gif": "animation",
}
MEDIA_EXTENSION = {
    ".jpg": "photo",
    ".jpeg": "photo",
    ".png": "photo",
    ".mp4": "video",
    ".gif": "animation",
}


@dataclass(frozen=True)
class Location:
    folder_id: str
    file_id: str
    file_name: str
    latitude: float
    longitude: float
    media_kind: str
    size_bytes: int | None = None


class DriveError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class UnusableMedia(DriveError):
    """A single file cannot be used, but other queued files may work."""


def parse_coordinates(name: str) -> tuple[float, float]:
    match = COORDINATES.fullmatch(name)
    if match is None:
        raise ValueError("Ожидается название «широта, долгота»")
    latitude, longitude = map(float, match.groups())
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Координаты за допустимыми пределами")
    return latitude, longitude


def _media_kind(file: dict) -> str | None:
    mime = file.get("mimeType", "")
    if mime in ("", "application/octet-stream"):
        return MEDIA_EXTENSION.get(Path(file["name"]).suffix.lower())
    return MEDIA_MIME.get(mime)


def _check_response(response) -> None:
    if response.status_code != 200:
        raise DriveError(f"Google Drive API вернул HTTP {response.status_code}", response.status_code)


class DriveClient:
    def __init__(self, root_folder_id: str, credentials_path: Path | str, auth_mode: str):
        self.root_folder_id = root_folder_id
        self.credentials_path = Path(credentials_path)
        self.auth_mode = auth_mode

    def _session(self) -> AuthorizedSession:
        try:
            if self.auth_mode == "service_account":
                credentials = ServiceCredentials.from_service_account_file(
                    self.credentials_path, scopes=[DRIVE_SCOPE]
                )
            elif self.auth_mode == "oauth":
                credentials = Credentials.from_authorized_user_file(
                    self.credentials_path, scopes=[DRIVE_SCOPE]
                )
            else:
                raise ValueError("неизвестный способ авторизации")
        except (OSError, ValueError, GoogleAuthError) as exc:
            raise DriveError(f"Проверьте файл учётных данных Google Drive ({self.auth_mode})") from exc
        return AuthorizedSession(credentials, refresh_timeout=REQUEST_TIMEOUT)

    def _metadata(self, session: AuthorizedSession, url: str, params: dict) -> dict:
        with session.get(url, params=params, timeout=REQUEST_TIMEOUT) as response:
            _check_response(response)
            return response.json()

    def _children(self, session: AuthorizedSession, folder_id: str, *, folders_only: bool = False) -> Iterator[dict]:
        escaped_id = folder_id.replace("\\", "\\\\").replace("'", "\\'")
        query = f"'{escaped_id}' in parents and trashed = false"
        if folders_only:
            query += f" and mimeType = '{FOLDER_MIME}'"
        params = {
            "q": query,
            "fields": "nextPageToken,incompleteSearch,files(id,name,mimeType,size,capabilities(canDownload))",
            "pageSize": 100,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        while True:
            page = self._metadata(session, FILES_URL, params)
            if page.get("incompleteSearch"):
                raise DriveError("Google Drive вернул неполный список файлов")
            yield from page.get("files", [])
            token = page.get("nextPageToken")
            if not token:
                return
            params["pageToken"] = token

    def _scan(self) -> list[Location]:
        with self._session() as session:
            root = self._metadata(
                session,
                f"{FILES_URL}/{quote(self.root_folder_id, safe='')}",
                {"fields": "mimeType,trashed", "supportsAllDrives": "true"},
            )
            if root.get("mimeType") != FOLDER_MIME or root.get("trashed"):
                raise DriveError("Корневой объект Google Drive должен быть доступной папкой")
            locations = []
            for folder in self._children(session, self.root_folder_id, folders_only=True):
                folder_id = folder["id"]
                try:
                    latitude, longitude = parse_coordinates(folder["name"])
                except ValueError as exc:
                    logger.warning("Папка Drive %s пропущена. %s", folder_id, exc)
                    continue
                try:
                    media = [
                        (file, kind)
                        for file in self._children(session, folder_id)
                        if (kind := _media_kind(file)) is not None
                    ]
                except DriveError as exc:
                    if exc.status != 404:
                        raise
                    logger.warning("Папка Drive %s больше недоступна", folder_id)
                    continue
                if len(media) != 1:
                    logger.warning("Папка Drive %s пропущена. Поддерживаемых медиафайлов: %s", folder_id, len(media))
                    continue
                file, kind = media[0]
                size = int(file["size"]) if file.get("size") is not None else None
                if size == 0 or file.get("capabilities", {}).get("canDownload") is False:
                    logger.warning("Папка Drive %s пропущена. Файл пуст или недоступен для скачивания", folder_id)
                    continue
                locations.append(Location(folder_id, file["id"], file["name"], latitude, longitude, kind, size))
            return locations

    async def scan(self) -> list[Location]:
        try:
            return await asyncio.to_thread(self._scan)
        except (RequestException, GoogleAuthError) as exc:
            raise DriveError("Не удалось прочитать Google Drive") from exc

    def _download(self, file_id: str, destination: Path, max_bytes: int) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        url = f"{FILES_URL}/{quote(file_id, safe='')}"
        deadline = monotonic() + DOWNLOAD_TIMEOUT
        temporary_path = None
        try:
            with self._session() as session, session.get(
                url,
                params={"alt": "media", "supportsAllDrives": "true"},
                headers={"Accept-Encoding": "identity"},
                stream=True,
                timeout=REQUEST_TIMEOUT,
            ) as response:
                _check_response(response)
                length = response.headers.get("Content-Length", "")
                if length.isdecimal() and int(length) > max_bytes:
                    raise UnusableMedia("Файл Google Drive превышает допустимый размер")
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                    temporary_path = Path(output.name)
                    written = 0
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if monotonic() > deadline:
                            raise DriveError("Истекло время скачивания файла Google Drive")
                        written += len(chunk)
                        if written > max_bytes:
                            raise UnusableMedia("Файл Google Drive превышает допустимый размер")
                        output.write(chunk)
                    if not written:
                        raise UnusableMedia("Google Drive вернул пустой файл")
            temporary_path.replace(destination)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    async def download(self, file_id: str, destination: Path, max_bytes: int) -> None:
        try:
            await asyncio.to_thread(self._download, file_id, destination, max_bytes)
        except (RequestException, GoogleAuthError) as exc:
            raise DriveError("Не удалось скачать файл Google Drive") from exc


def authorize_oauth(client_json: Path, token_json: Path) -> None:
    from google_auth_oauthlib.flow import InstalledAppFlow

    if token_json.exists():
        raise SystemExit("Файл OAuth уже существует. Укажите новый путь для авторизации.")
    flow = InstalledAppFlow.from_client_secrets_file(client_json, scopes=[DRIVE_SCOPE])
    credentials = flow.run_local_server(host="127.0.0.1", port=0, prompt="consent")
    if not credentials.refresh_token:
        raise SystemExit("Google не выдал refresh token. Повторите авторизацию с согласием на доступ.")
    with os.fdopen(os.open(token_json, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        output.write(credentials.to_json(strip=["token", "expiry"]))
    print(f"Файл учётных данных сохранён: {token_json}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Авторизация Google Drive OAuth на компьютере с браузером")
    parser.add_argument("client_json", type=Path, help="JSON OAuth-клиента типа Desktop app")
    parser.add_argument("token_json", type=Path, help="путь для нового файла учётных данных")
    args = parser.parse_args()
    authorize_oauth(args.client_json, args.token_json)
