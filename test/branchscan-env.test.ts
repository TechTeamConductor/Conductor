import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envValueIsSecretLike, loadEnvEntries, secretLikeEnvValues } from '../src/git/envvalues.ts';
import { scanBranchForSecrets } from '../src/git/branchscan.ts';
import { isolateGitHome, makeRepo, tmpDir } from './helpers/tmp-repo.ts';

isolateGitHome();

const POS: [string, string][] = [
  ['STRIPE_SECRET_KEY', 'abc12345'],
  ['API_TOKEN', 'x'],
  ['MY_JWT', 'short'],
  ['HMAC_KEY', 'q'],
  ['WALLET_SEED', 'word'],
  ['MNEMONIC', 'a b c'],
  ['PIN', '482913'],
  ['OTP_CODE', '123456'],
  ['LICENSE', 'AAAA-BBBB'],
  ['DB_CONNECTION', 'whatever'],
  ['SERVICE_URI', 'whatever'],
  ['DATABASE_URL', 'postgres'],
  ['clientSecret', 'abc'],
  ['SESSION_ID', 'abc'],
  ['FOO', 'postgres://user:pw@db.example.com/app'],
  ['FOO', 'https://api.example.com/v1?token=abc123'],
  ['FOO', 'https://api.example.com/v1?api_key=abc123'],
  ['FOO', 'ftp://a:b@h'], // short: only the userinfo rule can catch it
  ['FOO', 'x://h?token=a'], // short: only the query rule
  ['FOO', 'a1B2c3D4e5F6g7H8i9J0'], // 20 chars mixed
  ['FOO', 'deadbeefdeadbeefdeadbeef'], // hex
  ['FOO', 'Ab1!Ab1!Ab1!Ab1!'], // 16 chars 4 classes
  ['FOO', 'line1\nline2'], // multi-line
  ['FOO', 'has some spaces and is long enough'], // doubt
  ['FOO', 'zzzzzzzzzzzzzzzzzzzzzzzz'], // 24 single-class letters
  // review M3: 8-15 character passwords and passphrases under a harmless name
  ['ROOT_PW', 'Tr0ub4dor&3'],
  ['ADMIN_LOGIN', 'P@ssw0rd123'],
  ['X', 'Ab1!Ab1!Ab1!'],
  ['FOO', 'hunter2hunter'],
  ['FOO', 'Winter2024!'],
  ['FOO', 'correct-Horse9'],
  // hostname-shaped passphrases are not hostnames
  ['FOO', 'Summer2024.Company.Passw0rd'],
  ['FOO', 'summer2024.company.passw0rd'],
  ['FOO', 'correct.horse.battery.staple'],
  ['FOO', 'Correct.Horse.Battery'],
];
const NEG: [string, string][] = [
  ['APP_URL', 'https://app.example.com'],
  ['API_BASE', 'https://api.example.com:8443/v1/'],
  ['AWS_REGION', 'us-east-1'],
  ['HOST', 'db.internal.example.com'],
  ['DEBUG', 'true'],
  ['MODE', 'production'],
  ['LOG_LEVEL', 'verbose'],
  ['TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:orders-topic'],
  ['DATA_DIR', '/var/lib/app/data'],
  ['PORT', '3000'],
  ['SERVICE_NAME', 'checkout-api-production'],
  ['REDIS_HOST', 'redis.default.svc.cluster.local'],
  ['SMTP_HOST', 'smtp.mail.example.co'],
  ['HOST', 'db.eu.example.io'],
  ['NODE_ENV', 'production'],
  ['STAGE', 'Production'],
  ['BUILD', 'STAGING'],
  ['TIMEOUT_MS', '1234567890'],
];

describe('envValueIsSecretLike', () => {
  for (const [n, v] of POS) it(`secret-like: ${n}`, () => assert.equal(envValueIsSecretLike(n, v), true));
  for (const [n, v] of NEG) it(`not secret-like: ${n}`, () => assert.equal(envValueIsSecretLike(n, v), false));
  it('bare URL exemption runs before the 16-char rule but not before userinfo', () => {
    assert.equal(envValueIsSecretLike('X', 'https://example.com/docs'), false);
    assert.equal(envValueIsSecretLike('X', 'https://u:p@example.com/docs'), true);
  });
});

describe('secretLikeEnvValues / loadEnvEntries', () => {
  it('ANY entry carrying the value qualifies it', () => {
    const v = 'https://app.example.com';
    assert.deepEqual(secretLikeEnvValues([{ name: 'APP_URL', value: v }]), []);
    assert.deepEqual(secretLikeEnvValues([{ name: 'APP_URL', value: v }, { name: 'AUTH_CALLBACK', value: v }]), [v]);
  });
  it('multi-line values qualify with the whole value and each substantial line', () => {
    const pem = ['-----BEGIN ' + 'PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '-----END ' + 'PRIVATE KEY-----'].join('\n');
    const vals = secretLikeEnvValues([{ name: 'ANYTHING', value: pem, multiline: true }]);
    assert.ok(vals.includes(pem));
    assert.ok(vals.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
  });
  it('parses names, quotes, comments and multi-line values', () => {
    const d = tmpDir('env');
    const f = join(d, '.env');
    writeFileSync(f, ['A_URL=https://x.example.com # c', 'export B_TOKEN="tok_1234567890abcdef"', 'PEM="-----BEGIN K-----', 'body-line-123456789', '-----END K-----"', '# comment', ''].join('\n'));
    const e = loadEnvEntries([f]);
    assert.deepEqual(e.map((x) => [x.name, x.multiline]), [['A_URL', false], ['B_TOKEN', false], ['PEM', true]]);
    assert.equal(e[0]!.value, 'https://x.example.com');
    assert.equal(e[1]!.value, 'tok_1234567890abcdef');
    assert.deepEqual(loadEnvEntries([join(d, 'missing')]), []);
  });
});

describe('scanBranchForSecrets with env entries (mutations: qualifying value blocks in every file type)', () => {
  const SECRET = { name: 'STRIPE_SECRET_KEY', value: 'plainwordvalue1' };
  const PUBLIC = { name: 'APP_URL', value: 'https://app.example.com/landing' };

  for (const file of ['docs/notes.md', 'config/x.json', 'src/app.js', 'test/fixtures/data.txt']) {
    it(`qualifying value blocks in ${file}; public value does not`, async () => {
      const r = makeRepo();
      const base = r.head();
      r.write(file, `value: ${SECRET.value}\nsite: ${PUBLIC.value}\n`);
      r.commit('add');
      const out = await scanBranchForSecrets(r.dir, base, [SECRET, PUBLIC]);
      assert.equal(out.length, 1);
      assert.match(out[0]!, /copied from an \.env/);
      assert.ok(!out.join('').includes(SECRET.value));
      r.write(file, `site: ${PUBLIC.value}\n`);
      const r2 = makeRepo();
      const b2 = r2.head();
      r2.write(file, `site: ${PUBLIC.value}\n`);
      r2.commit('add');
      assert.deepEqual(await scanBranchForSecrets(r2.dir, b2, [SECRET, PUBLIC]), []);
    });
  }

  it('a deleted-then-readded file still blocks (the add commit is scanned)', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('docs/a.md', `k ${SECRET.value}\n`);
    r.commit('add');
    r.git(['rm', '-q', 'docs/a.md']);
    r.commit('rm');
    assert.equal((await scanBranchForSecrets(r.dir, base, [SECRET])).length, 1, 'added then removed is still found');
    r.write('docs/a.md', `k ${SECRET.value}\n`);
    r.commit('readd');
    assert.equal((await scanBranchForSecrets(r.dir, base, [SECRET])).length, 1);
  });

  it('legacy string entries fail closed (every value qualifies)', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('a.md', 'see https://app.example.com/landing\n');
    r.commit('x');
    assert.equal((await scanBranchForSecrets(r.dir, base, ['https://app.example.com/landing'])).length, 1);
  });

  it('git failure is a finding, not an empty list', async () => {
    const r = makeRepo();
    const out = await scanBranchForSecrets(r.dir, '0'.repeat(40), [SECRET]);
    assert.match(out[0]!, /could not complete/);
  });
});
