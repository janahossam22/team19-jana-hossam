// Starts the API in the AWS version of the app (Floci, later ECS) - Jana Hossam, issue #43
//
// 1. Reads JWT_SECRET and CRON_SECRET from AWS Secrets Manager (secret
//    APP_SECRET_ID, e.g. team19/app), using the IAM role the container runs
//    as (team19-api). The values are never logged or written to a file.
// 2. Starts the Express API. The database pools log in with IAM tokens
//    (DB_IAM_AUTH=true, src/db/pool.js), so no database password exists.
// Fails closed: if a secret is missing or too short, the API does not start.

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const REQUIRED = ['JWT_SECRET', 'CRON_SECRET'];

async function loadSecrets() {
  const secretId = process.env.APP_SECRET_ID;
  if (!secretId) throw new Error('APP_SECRET_ID is not set');

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
    // Floci locally; on real AWS leave AWS_ENDPOINT_URL unset.
    endpoint: process.env.AWS_ENDPOINT_URL || undefined,
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  let values;
  try {
    values = JSON.parse(res.SecretString || '');
  } catch {
    throw new Error(`${secretId} is not valid JSON`);
  }
  for (const key of REQUIRED) {
    if (typeof values[key] !== 'string' || values[key].length < 32) {
      throw new Error(`${key} is missing or shorter than 32 characters in ${secretId}`);
    }
    process.env[key] = values[key];
  }
}

function log(level, message) {
  console.log(JSON.stringify({ level, message, time: new Date().toISOString() }));
}

async function main() {
  if (process.env.DB_IAM_AUTH !== 'true') {
    throw new Error('DB_IAM_AUTH must be true in the AWS version (IAM database login only)');
  }
  await loadSecrets();
  log('info', `Secrets loaded from ${process.env.APP_SECRET_ID}`);

  // Loaded only now, so the routes see the secrets.
  const app = require('./src/app');
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => log('info', `API running on port ${port}`));
}

main().catch((err) => {
  log('error', `Startup failed: ${err.message}`);
  process.exit(1);
});
