# poc-heroku-connect-failure-monitor

## Flow

```text
e3._trigger_log,bsna._trigger_log,apac._trigger_log
        │
        │ SELECT state='FAILED'
        ▼
custom.failed_records
        │
        │ WHERE notified = false
        ▼
SendGrid/Mailgun Email
        │
        ▼
UPDATE notified = true



Application / SQL       Heroku Postgres DB      Heroku Connect                        Salesforce                         Scheduler / Worker          Mailgun
        |                        |                    |                                    |                                        |                  |
        | INSERT/UPDATE/DELETE   |                    |                                    |                                        |                  |
        |----------------------->|                    |                                    |                                        |                  |
        |                        |  Row written       |                                    |                                        |                  |
        |                        |------------------->|                                    |                                        |                  |
        |                        | Object and s._t_l  | Push to SF                         |                                        |                  |
        |                        |                    |----------------------------------->|                                        |                  |
        |                        |                    |                                    | Reject (validation)                    |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    | Update to salesforce._trigger_log  |                                        |                  |
        |                        |                    |<-----------------------------------|                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |<-------------------|                                    |                                        |                  |
        |                        | state = FAILED     |                                    |                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                     (Runs every X mins)|                  |
        |                        |<-------------------------------------------------------------------------------------------------|                  |
        |                        |                    |   Start job -  Checks salesforce.trigger_log for records with FAILED state  |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                         INSERT new FAILED records to custom.failed_records  |                  |
        |                        |<-------------------------------------------------------------------------------------------------|                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                SELECT unnotified  FAILED records from custom.failed_records |                  |
        |                        |<-------------------------------------------------------------------------------------------------|                  | 
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                                        | Send email       |
        |                        |                    |                                    |                                        |----------------->|
        |                        |                    |                                    |                                        |                  | Deliver mail
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                                    |                                        |                  |
        |                        |                    |                            UPDATE  notified records in custom.failed_records|                  |
        |                        |<-------------------------------------------------------------------------------------------------|                  |
        |                        |                    |                                    |                                        |                  | 
        |                        |                    |                                    |                                        |                  | 
   
```


Components:
- Application / SQL
- Heroku Postgres DB
- Heroku Connect
- Salesforce
- Scheduler / Worker
- Mailgun

Flow:

1. Application performs INSERT / UPDATE on Postgres table.
2. Row is written to Heroku Postgres DB.
3. Heroku Connect detects change and writes to salesforce._trigger_log table.
4. Heroku Connect pushes record to Salesforce.
5. Salesforce rejects record (e.g., validation rule failure).
6. Heroku Connect updates entry to:
      salesforce._trigger_log
      state = FAILED

7. Scheduler / Worker (runs every X minutes):
      → Checks e3._trigger_log,bsna._trigger_log,apac._trigger_log for FAILED records.

8. Inserts new FAILED records into:
      custom.failed_records

9. Selects unnotified FAILED records from:
      custom.failed_records

10. Sends HTML email notification via Mailgun.

11. Mailgun delivers email.

12. System updates:
      custom.failed_records
      set notified = true
