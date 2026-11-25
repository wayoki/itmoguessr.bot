import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { synchronous } from './google-transform.js';

export async function buildGoogle() {
  const target = 'google/dist';
  await mkdir(target, { recursive: true });
  const sync = synchronous(await readFile('google/sync.js', 'utf8'), { helpers: true });
  const sqlite = synchronous(await readFile('node_modules/sql.js/dist/sql-asm.js', 'utf8'), { compact: true });
  const sqlBundle = `function loadGoogleSqlite() {\n${sync}\nconst Promise = Immediate;\nconst TextDecoder = Utf8Decoder; const TextEncoder = Utf8Encoder;\n${sqlite}\nreturn unwrap(initSqlJs());\n}\n`;
  const db = synchronous(await readFile('google/database.js', 'utf8'));
  const additions = synchronous(await readFile('locations-add.js', 'utf8'), { core: true });
  const core = synchronous(await readFile('index.js', 'utf8'), {
    core: true, removeFunctions: ['driveToken', 'driveFetch', 'telegram', 'upload', 'mapsRedirect'],
  });
  const communityMigration = await readFile('drizzle/0008_community_panoramas.sql', 'utf8');
  const bridges = `
    function migrateCommunityPanoramas(sqlite) {
      if (sqlite.exec("SELECT 1 FROM settings WHERE key='schema:community_panoramas'").length) return false;
      sqlite.run('BEGIN');
      try {
        sqlite.run(${JSON.stringify(communityMigration)});
        sqlite.run('COMMIT');
      } catch (error) {
        sqlite.run('ROLLBACK');
        throw error;
      }
      return true;
    }
    function mapsRedirect(url) {
      if (platform.mapsRedirect) return platform.mapsRedirect(url);
      const response = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      const status = response.getResponseCode();
      if (status < 300 || status >= 400) return null;
      const headers = response.getHeaders();
      return headers.Location || headers.location || null;
    }
    function driveToken(env) { return platform.driveToken(env, ApiFailure); }
    function driveFetch(env, path, params, timeout) { return platform.driveFetch(env, path, params, timeout, ApiFailure); }
    function telegram(env, method, body, contentType) { return platform.telegram(env, method, body, contentType, ApiFailure); }
    function upload(env, location, round, source) { return platform.upload(env, location, round, source, ApiFailure, roundPost(round)); }
  `;
  const names = ['coordinates','filenameLocation','filenameCoordinates','score','activeSlots','remainingWeekSlots','weekCoverage','weekCoverageText','weeklyWindow','monthlyWindow','leaderboard','weeklySummary','monthlySummary','publish','tick','webhook','inventory','scanLocations','mediaMetadata','driveToken','resetTestRounds','GoogleDatabase','migrateCommunityPanoramas'];
  const bundle = `function createGoogleCore(platform) {\n${sync}\nconst gasAll = Immediate.all;\nconst TextEncoder = Utf8Encoder; const TextDecoder = Utf8Decoder;\nconst Response = platform.Response; const crypto = { randomUUID: platform.uuid };\n${db}\n${bridges}\n${additions}\n${core}\nreturn { ${names.join(', ')} };\n}\n`;
  const migrations = [];
  for (const name of (await readdir('drizzle')).filter(x => x.endsWith('.sql')).sort()) migrations.push(await readFile('drizzle/' + name, 'utf8'));
  const schema = migrations.join('\n') + '\nCREATE TABLE google_updates (id INTEGER PRIMARY KEY, status TEXT NOT NULL, updated INTEGER NOT NULL);\n';
  const files = { 'sqlite.js': sqlBundle, 'core.js': bundle, 'schema.sql': schema };
  const manifest = {};
  for (const [name, content] of Object.entries(files)) {
    const download = name === 'sqlite.js' ? 'sqlite.js.gz' : name;
    await writeFile(`${target}/${download}`, name === 'sqlite.js' ? gzipSync(content) : content);
    manifest[name] = { sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), download, gzip: name === 'sqlite.js' };
  }
  await writeFile(`${target}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(`${target}/SQLITE-LICENSE.txt`, await readFile('node_modules/sql.js/LICENSE', 'utf8'));
  await writeFile(`${target}/Code.gs`, await readFile('google/bootstrap.gs', 'utf8') + '\n' + await readFile('google/platform.gs', 'utf8'));
  return { sqlBundle, bundle, schema, manifest };
}
if (process.argv[1]?.endsWith('/build-google.js') || process.argv[1] === 'scripts/build-google.js') {
  const result = await buildGoogle();
  console.log('Google build:', Object.fromEntries(Object.entries(result.manifest).map(([k, v]) => [k, v.bytes])));
}
