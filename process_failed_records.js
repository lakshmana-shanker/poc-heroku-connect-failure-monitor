import pkg from 'pg';
import Mailgun from 'mailgun.js';
import formData from 'form-data';
const environment = process.argv[2];
if (!environment) {
throw new Error ('Environment parameter is required: UAT or PROD')}
const { Pool } = pkg;

/* ===========================
   CONFIG
=========================== */

const MAX_EMAIL_RECORDS = 50; // safety limit

const {MAILGUN_API_KEY} = process.env;
let DATABASE_URL;
let MAILGUN_DOMAIN;
let ALERT_EMAIL_TO;
let NODE_ENV;
if (environment ==='UAT'){
DATABASE_URL= process.env.UAT_DATABASE_URL;
MAILGUN_DOMAIN = process.env.UAT_MAILGUN_DOMAIN; 
ALERT_EMAIL_TO = process.env.UAT_ALERT_EMAIL_TO;
NODE_ENV = 'UAT'; 
}
else if (environment ==='PROD') {
DATABASE_URL= process.env.PROD_DATABASE_URL;
MAILGUN_DOMAIN = process.env.PROD_MAILGUN_DOMAIN; 
ALERT_EMAIL_TO = process.env.PROD_ALERT_EMAIL_TO;
NODE_ENV = 'PROD';  
}   
else {
throw new Error ('Invalid Environment: Use UAT or PROD');
}
if (!DATABASE_URL || !MAILGUN_API_KEY || !MAILGUN_DOMAIN || !ALERT_EMAIL_TO) {
  console.error(' Missing required environment variables');
}

/* ===========================
   DATABASE
=========================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

/* ===========================
   MAILGUN
=========================== */

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: MAILGUN_API_KEY
});

const FROM_EMAIL = `Heroku Monitoring <alerts@${MAILGUN_DOMAIN}>`;

/* ===========================
   SQL
=========================== */

const INSERT_FAILED_SQL = `
INSERT INTO custom.failed_records
("Source",trigger_log_id, txid, created_at, updated_at, processed_at, processed_tx,
 state, action, table_name, record_id, sfid, old, values, sf_result, sf_message)
SELECT 'E3'as Source_org,id, txid, created_at, updated_at, processed_at, processed_tx,
       state, action, table_name, record_id, sfid, old, values,
       sf_result, sf_message
FROM e3._trigger_log
WHERE state = 'FAILED'
UNION ALL
SELECT 'BSNA'as Source_org,id, txid, created_at, updated_at, processed_at, processed_tx,
       state, action, table_name, record_id, sfid, old, values,
       sf_result, sf_message
FROM bsna._trigger_log
WHERE state = 'FAILED'
UNION ALL
SELECT 'APAC'as Source_org,id, txid, created_at, updated_at, processed_at, processed_tx,
       state, action, table_name, record_id, sfid, old, values,
       sf_result, sf_message
FROM apac._trigger_log
WHERE state = 'FAILED'
ON CONFLICT (trigger_log_id) DO NOTHING;
`;

const FETCH_UNNOTIFIED_SQL = `
SELECT *
FROM custom.failed_records
WHERE notified = false
ORDER BY created_at ASC
LIMIT $1;
`;

const MARK_NOTIFIED_SQL = `
UPDATE custom.failed_records
SET notified = true
WHERE trigger_log_id = ANY($1);
`;

/* ===========================
   HTML EMAIL BUILDER
=========================== */

function buildHtmlEmail(rows) {
  const tableRows = rows.map(r => `
    <tr>
      <td>${r.Source}</td>
      <td>${r.trigger_log_id}</td>
      <td>${r.txid || 'N/A'}</td>
      <td>${r.table_name}</td>
      <td>${r.action}</td>
      <td>${r.record_id}</td>
      <td>${r.sfid || 'N/A'}</td>
      <td>${r.sf_result || 'N/A'}</td>
      <td style="max-width:300px; word-wrap:break-word;">
        ${r.sf_message || 'N/A'}
      </td>
      <td style="max-width:300px; word-wrap:break-word; font-size:11px;">
        ${r.values || 'N/A'}
      </td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
    </tr>
  `).join('');

  return `
  <div style="font-family: Arial, sans-serif; color:#333;">
    <h2 style="color:#d32f2f;">
      Heroku Connect – FAILED Sync Alert
    </h2>

    <p>
      <strong>Environment:</strong> ${NODE_ENV}<br/>
      <strong>Total Failed Records:</strong> ${rows.length}
    </p>

    <table border="1" cellpadding="6" cellspacing="0"
      style="border-collapse:collapse; width:100%; font-size:12px;">
      <thead style="background:#f5f5f5;">
        <tr>
          <th>Trigger Log ID</th>
          <th>TXID</th>
          <th>Table</th>
          <th>Action</th>
          <th>Record ID</th>
          <th>SFID</th>
          <th>Error Code</th>
          <th>Error Message</th>
          <th>Values</th>
          <th>Created At</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <p style="margin-top:15px; font-size:12px; color:#777;">
      This is an automated alert from your Heroku application.
    </p>
  </div>
  `;
}

/* ===========================
   MAIN
=========================== */

async function run() {
  let client;

  try {
    client = await pool.connect();

    console.log('\n=== Syncing FAILED records from salesforce._trigger_log ===');

    const insertResult = await client.query(INSERT_FAILED_SQL);

    console.log(
      `\x1b[1mInserted ${insertResult.rowCount} new FAILED record(s) into custom.failed_records\x1b[0m`
    );
    console.log('Fetching unnotified FAILED records from table custom.failed_records...');
    const { rows } = await client.query(
      FETCH_UNNOTIFIED_SQL,
      [MAX_EMAIL_RECORDS]
    );

    if (!rows || rows.length === 0) {
        console.log(
          '\x1b[1m\x1b[32mNo new unnotified FAILED records found in table custom.failed_records\x1b[0m'
        );      return;
    }
        console.log(
          `\x1b[1m\x1b[31m${rows.length} FAILED record(s) detected in table custom.failed_records\x1b[0m`
        );
    const htmlBody = buildHtmlEmail(rows);
    const triggerIds = rows.map(r => r.trigger_log_id);

    console.log('Sending Mailgun notification...');

    try {
      await mg.messages.create(MAILGUN_DOMAIN, {
        from: FROM_EMAIL,
        to: ALERT_EMAIL_TO.split(','),
        subject: `[${NODE_ENV}] Heroku Connect Sync Failures – ${rows.length} record(s)`,
        text: `Heroku Connect Monitoring has identified: ${rows.length} failed synchronization record(s). Please review and take necessary action`,
        html: htmlBody
      });

      console.log(
        '\x1b[1m\x1b[32mEmail sent successfully\x1b[0m'
      );

      console.log(
        '\x1b[1m\x1b[32mMarking records as notified...\x1b[0m'
      );
      await client.query(MARK_NOTIFIED_SQL, [triggerIds]);
    } catch (mailError) {
      // Mail issues must NEVER crash the dyno
      console.error('⚠ Mailgun error (non-fatal)');
      console.error(mailError.message);
      console.error('Status:', mailError.status);
    }

  } catch (err) {
    console.error(
      '\x1b[1m\x1b[31mError while processing FAILED records\x1b[0m'
    );
    console.error(err);
  } finally {
    if (client) client.release();
    await pool.end();
    console.log('process_failed_records completed');
  }
}

run();
