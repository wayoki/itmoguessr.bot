# ITMOGUESSR\* — Telegram-бот для тренировок

[@itmoguessr_bot](https://t.me/itmoguessr_bot) публикует локации из Google Drive. Игрок открывает раунд по кнопке в канале и отправляет в личный чат одну выбранную точку на карте. После раскрытия бот публикует правильную точку и число участников, а игрокам отправляет расстояние, очки и ссылку на Google Maps. Расстояние считается по формуле гаверсинуса, очки от 0 до 5000 — по приближённой формуле для карты GeoGuessr World.

Бот работает в одном контейнере на Python 3.12 и aiogram 3. Telegram Long Polling использует исходящее подключение, поэтому на VPS достаточно доступа к Telegram Bot API и Google APIs. Домен, сертификат и входящий HTTP-порт для бота не требуются.

## Развёртывание на Ubuntu VPS

### 1. Клонируй репозиторий

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/wayoki/itmoguessr.bot.git
cd itmoguessr.bot
```

Для приватного репозитория используй настроенный доступ к GitHub. Все следующие команды на VPS выполняй из каталога репозитория.

### 2. Установи Docker Engine и Compose

На новой Ubuntu добавь официальный репозиторий Docker. Если Docker Engine и плагин Compose уже установлены, проверь их версии и переходи к следующему шагу. [Инструкция Docker для Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
cat <<EOF | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
docker compose version
```

Если у пользователя нет доступа к Docker Engine, выполняй приведённые ниже команды `docker compose` через `sudo`.

### 3. Заполни `.env`

```bash
install -d -m 0700 data secrets
install -m 0600 .env.example .env
id -u
id -g
```

Открой `.env` и заполни переменные.

| Переменная | Значение |
| --- | --- |
| `BOT_TOKEN` | Токен `@itmoguessr_bot` из [@BotFather](https://t.me/BotFather). |
| `BOT_UID`, `BOT_GID` | Вывод `id -u` и `id -g` для пользователя VPS, которому принадлежат каталоги `data` и `secrets`. |
| `DRIVE_AUTH_MODE` | `service_account` для основного варианта или `oauth` для альтернативы. |
| `DRIVE_CREDENTIALS_PATH` | Путь внутри контейнера. Для сервисного аккаунта оставь `/run/itmoguessr/service-account.json`. |
| `TELEGRAM_CHANNEL`, `TELEGRAM_ANNOUNCEMENT_CHANNEL`, `ADMIN_IDS` | Заполни по шагу 6. |

В `config/settings.yaml` временно поменяй `enabled` на `false` в блоке `schedule`, чтобы первый раунд начать вручную. Храни `.env`, Google-ключи и токены только локально. Git исключает `.env`, `secrets/` и `data/`.

### 4. Включи Google Drive API и создай сервисный аккаунт

1. В Google Cloud Console выбери или создай проект. В разделе **APIs & Services → Library** включи **Google Drive API**. [Карточка Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. В **IAM & Admin → Service Accounts** создай сервисный аккаунт. Права на проект для чтения расшаренной папки Drive ему не нужны. [Создание сервисного аккаунта](https://docs.cloud.google.com/iam/docs/service-accounts-create).
3. Открой созданный аккаунт, перейди в **Keys → Add key → Create new key** и скачай JSON-ключ. Передай его на VPS по SSH и сохрани как `secrets/service-account.json`. На VPS выполни `chmod 600 secrets/service-account.json`. [Создание JSON-ключа](https://docs.cloud.google.com/iam/docs/keys-create-delete).

#### Альтернатива через OAuth

Если политика организации запрещает создание ключей или доступ сервисного аккаунта к папке, используй Google-аккаунт с правом чтения и скачивания из неё.

1. В том же проекте настрой **Google Auth Platform**. В **Data Access** добавь область доступа `https://www.googleapis.com/auth/drive.readonly`. Для внешнего приложения в режиме **Testing** добавь нужный Google-аккаунт в список тестовых пользователей. В этом режиме авторизация с доступом к Drive обычно действует семь дней. [Режимы доступа Google Auth Platform](https://support.google.com/cloud/answer/15549945).
2. В **Clients** создай OAuth-клиент типа **Desktop app** и скачай его JSON. [OAuth для настольных приложений](https://developers.google.com/identity/protocols/oauth2/native-app).
3. На компьютере с браузером и Python 3.12+ из корня копии репозитория выполни команды ниже. Сохрани скачанный JSON клиента под именем `secrets/oauth-client.json` перед последней командой.

```bash
mkdir -p secrets
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m bot.drive secrets/oauth-client.json secrets/oauth-token.json
```

Выбери в браузере Google-аккаунт с доступом к локациям. Передай на VPS полученный `secrets/oauth-token.json`, установи для него права `600` и обнови `.env`.

```dotenv
DRIVE_AUTH_MODE=oauth
DRIVE_CREDENTIALS_PATH=/run/itmoguessr/oauth-token.json
```

### 5. Предоставь доступ к папке локаций

Открой корневую папку, нажми **Поделиться**, добавь адрес `client_email` из JSON сервисного аккаунта с ролью **Читатель** и проверь, что читателю разрешено скачивание. Для OAuth доступ нужен аккаунту, который дал согласие на предыдущем шаге. Бот читает данные с областью доступа `drive.readonly`. [Папка локаций клуба](https://drive.google.com/drive/folders/1rlP26NNEgdsHkv1n1QGo9SAkaT6aCady).

Папка уже указана в `drive.root_folder_id`. Если используешь отдельную папку для тестов, подставь её ID и сохрани ту же структуру.

```text
ITMOGUESSR Locations/
├── 35.0116, 135.7681/
│   └── location.mp4
└── 48.8566, 2.3522/
    └── location.jpg
```

Каждая подпапка должна содержать одну локацию с названием `широта, долгота` и одним поддерживаемым медиафайлом. Имя файла произвольное. Поддерживаются JPG, JPEG и PNG до 10 МБ, MP4 и GIF до 50 МБ. Для MP4 используй видео, которое Telegram воспроизводит в клиенте, например H.264. Для раундов готовь файлы без GPS-метаданных и подсказок в кадре, если по ним можно сразу узнать ответ. [Ограничения загрузки Telegram Bot API](https://core.telegram.org/bots/api#sending-files).

Бот пропускает папки с неверными координатами и папки без одного однозначно выбранного медиафайла. Использованная папка учитывается по ID, поэтому переименование не вернёт её в очередь.

### 6. Настрой каналы и администраторов

В Telegram добавь `@itmoguessr_bot` администратором каждого указанного канала. Достаточно права **Публикация сообщений**. Для тестового канала заполни `.env` по этому образцу.

```dotenv
TELEGRAM_CHANNEL=@swidfkjew
TELEGRAM_ANNOUNCEMENT_CHANNEL=@swidfkjew
ADMIN_IDS=123456789,987654321
```

`TELEGRAM_CHANNEL` получает медиа и раскрытия. `TELEGRAM_ANNOUNCEMENT_CHANNEL` получает сообщения о принятых предположениях. Для теста это один канал. Для приватного канала используй его числовой ID вида `-100…` целиком.

Заменяй числа в `ADMIN_IDS` своими Telegram User ID, разделяя их запятыми. Если ID неизвестен, оставь `ADMIN_IDS=` пустым и при выключенном расписании запусти контейнер по шагу 7. Отправь боту `/start` в личном чате, скопируй ID из ответа, обнови `.env` и выполни `docker compose up -d --force-recreate`.

### 7. Запусти контейнер

```bash
docker compose up -d --build
docker compose ps
```

Запускай один экземпляр для этого токена. Compose хранит SQLite в `./data/bot.sqlite3` на VPS и перезапускает контейнер после сбоя по правилу `unless-stopped`. Команда `docker compose down` останавливает и удаляет контейнер, сохраняя каталог `./data`.

### 8. Проверь логи

```bash
docker compose logs -f
```

`Ctrl+C` закрывает просмотр логов, бот продолжает работать. Открой личный чат с ботом и отправь `/status` с аккаунта из `ADMIN_IDS`. Команда покажет активные раунды, очередь и сведения об отправках с ошибками или неподтверждённым статусом.

### 9. Проверь чтение и загрузку из Google Drive

```bash
docker compose run --rm --no-deps bot python -m bot --check-drive
```

Команда читает список папок и скачивает один подходящий файл. Для этой проверки достаточно доступа к Drive. После успешного выполнения отправь `/sync` боту в личном чате, чтобы обновить очередь SQLite. Если очередь пуста, проверь названия подпапок, форматы медиа и предупреждения в логах. Если Drive возвращает 403 или 404, проверь, что API включён, ID папки верен и аккаунт имеет к ней доступ.

### 10. Проведи полный тестовый раунд

1. Подготовь в папке как минимум одну новую локацию с фото и одну с MP4. Проверь, что оба канала указывают на тестовый `@swidfkjew`, а расписание выключено. Отправь `/sync`, затем `/next` в личном чате администратора.
2. Открой публикацию. Кнопка **Сделать предположение** должна открыть нужный раунд в чате с ботом. Если Telegram показывает **Start**, нажми её. Через **Вложения → Геопозиция** передвинь метку на произвольную точку и отправь её как обычную геопозицию.
3. Проверь подтверждение в личном чате и уведомление с именем и номером раунда в тестовом канале. Координаты попытки остаются в базе. Попробуй ответить повторно и проверь сообщение о том, что попытка уже использована.
4. Пока раунд активен, выполни `docker compose restart`. После запуска проверь `/status` и повтори попытку с того же аккаунта. Раунд и уже использованная попытка должны сохраниться.
5. Отправь `/close N`, где `N` — номер раунда. Проверь правильную точку и число участников в канале. В личном чате должны появиться правильные координаты, расстояние, очки и ссылка на Google Maps. При точном совпадении ожидаются 0 км и 5000 очков.
6. Открой кнопку закрытого раунда и проверь, что приём ответов завершён. Повтори перезапуск и проверь, что пост и результаты не продублировались.
7. Повтори проверку с другим типом медиа. При последовательном выборе бот сортирует новые локации по имени файла, затем по ID папки.

Локальные тесты проекта используют тестовые ответы внешних сервисов.

```bash
docker compose run --rm --no-deps bot python -m unittest discover -s tests -v
```

### 11. Обнови бота

Сделай резервную копию по следующему шагу. Если на VPS менялся `config/settings.yaml`, временно сохрани его правки через `git stash push -m "Настройки VPS" -- config/settings.yaml`. Затем загрузи новую версию.

```bash
git pull --ff-only
```

Если сохранял правки, верни их командой `git stash pop`. Если Git сообщает о конфликте, перенеси свои настройки в новый YAML и проверь файл перед запуском. Пересобери контейнер.

```bash
docker compose up -d --build
docker compose logs -f
```

После изменения `.env` или `config/settings.yaml` примени настройки командой `docker compose up -d --force-recreate`.

### 12. Создай резервную копию SQLite

Команда делает согласованную копию базы, пока бот работает.

```bash
backup_name="backup-$(date +%F-%H%M%S).sqlite3"
docker compose exec -T bot python -m bot --backup "/data/$backup_name"
chmod 600 "data/$backup_name"
```

Скопируй файл из `data/` в защищённое хранилище. В копии находятся в том числе Telegram ID и координаты предположений.

## Настройки игры и команды

В `config/settings.yaml` находятся часовой пояс, время публикации и раскрытия, длительность ручного раунда, тексты уведомлений и порядок выбора локаций. Значение `drive.selection` можно изменить на `random`. Параметр `attempts_per_round` для MVP равен `1`. Уникальность попытки обеспечена в SQLite.

| Раунд | Публикация по Москве | Раскрытие по Москве |
| --- | --- | --- |
| Утренний | 10:00 | 19:00 |
| Вечерний | 20:00 | 09:00 следующего дня |

После теста включи `schedule.enabled: true` и примени настройки. При запуске бот закрывает просроченные активные раунды. Если момент публикации прошёл, но до раскрытия ещё есть время, бот может опубликовать раунд с прежним сроком закрытия. Пропущенные публикации с истёкшим сроком закрытия пропускаются.

| Команда в личном чате | Действие |
| --- | --- |
| `/status` | Показать состояние, очередь и активные раунды. |
| `/sync` | Перечитать папку Google Drive и обновить очередь. |
| `/next` | Опубликовать следующий раунд вручную. |
| `/close N` | Закрыть раунд с номером `N` и поставить результаты в очередь отправки. |
| `/pause` | Приостановить автоматические публикации. Пауза сохраняется после перезапуска. |
| `/resume` | Снять паузу. Автопубликации возобновятся при включённом расписании. |

Во время паузы доступны ручной запуск и раскрытие уже открытых раундов. Бот сохраняет состояние отправок в SQLite. Если Telegram мог принять запрос, но подтверждение потерялось при обрыве связи или остановке процесса, состояние помечается как неопределённое. Чтобы избежать дублей, такие отправки автоматически не повторяются, поэтому в редком случае уведомление может не дойти. Проверь публикацию в канале и сведения в `/status`. Раунд с неподтверждённой публикацией остаётся закрыт для ответов.
