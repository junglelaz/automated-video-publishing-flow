# One-time setup

Once this setup is finished, your repeated action is simply adding a video to the monitored Drive folder. Setup itself requires your own accounts and an initial authorisation.

## 1. Prepare your accounts

Create a private Google Drive folder for the workflow. Use a new or deliberately chosen folder: files already inside at first activation are recorded as existing and skipped. Never make source footage publicly shared to work around an import problem.

Use an OpusClip workspace with eligible API/MCP access and sufficient credits. Connect the YouTube, Instagram, TikTok and Facebook destinations you own or administer in OpusClip. Know exactly which Facebook Page should receive posts; an account that manages several Pages is not a sufficient destination by itself.

## 2. Create your private cloud worker

1. Create a standalone project in [Google Apps Script](https://script.google.com/), under the Google account that can read your source folder.
2. Copy all `.gs` files from this repository into that project. These source files are templates; do not copy `.test.cjs` files into Apps Script.
3. Enable the manifest in Project Settings and copy `appsscript.json`. Add the advanced **Drive API v3** service if it is not already present; enable the Drive API in the associated Google Cloud project if Google requests it.
4. Keep the Apps Script project private. Project editors can read its Script Properties, so do not share edit access casually.

The manifest requests read-only Drive access, external requests, trigger management and notification mail. It does not request Drive write/sharing access. The Drive grant is account-wide read-only; the code additionally restricts ingestion to the configured folder.

## 3. Enter private settings

Open Project Settings → Script Properties. Use `script-properties.example.json` as a field guide, not as a place to save real credentials in GitHub.

| Property | Value |
|---|---|
| `DRIVE_FOLDER_ID` | ID of your private source folder |
| `NOTIFICATION_EMAIL` | Your notification address |
| `OPUS_ORG_ID` | Your OpusClip workspace organisation ID |
| `OPUSCLIP_API_KEY` | Your own eligible OpusClip API key, entered privately |
| `DESTINATIONS_JSON` | JSON array of your exact four post-account destinations |
| `PUBLICATION_ENABLED` | Start with `false` |

`DESTINATIONS_JSON` must contain exactly one entry for each supported platform. Instagram and Facebook need explicit `subAccountId` values. The example uses placeholders; code rejects unfilled placeholders, missing child destinations, extra platforms and duplicates.

Do not upload a filled `script-properties.json`, `.env`, `.clasp.json`, export URL or token file to GitHub. The example leaves the API key blank on purpose.

## 4. Authorise full OpusClip cloud tools

The API key covers REST intake/upload calls. Full editing, rendered-media understanding and publishing tools use a separate OAuth connection to the official hosted MCP endpoint. Do not substitute the API key for an OAuth token.

1. Run `discoverCloudAuthorization`. This verifies official protected-resource metadata and the delegated authentication issuer. If discovery changes or fails validation, stop and check current official OpusClip documentation; do not bypass endpoint checks.
2. Run `registerCloudClient`. It registers a public PKCE client for this Apps Script project's callback URL, with no client secret.
3. Run `startCloudBrowserAuthorization`. Open the authorisation URL shown in the private execution log and approve your own cloud workflow in OpusClip. Do not share that URL, callback URL or log.
4. The callback page should say that the cloud workflow is connected. Access and refresh tokens remain in Script Properties.
5. Run `verifyCloudTools`. Confirm the connected workspace and API eligibility. The configured `OPUS_ORG_ID` must match this workspace.
6. Run `inspectConnectedDestinations` privately to get the exact post-account and subaccount identifiers for `DESTINATIONS_JSON`. Copy only the four intended destinations. Do not post the output in an issue or commit.

The current delegated issuer is pinned in `CloudOpus.gs`. A provider-side issuer change requires reviewing the official metadata and updating the pin; arbitrary issuer URLs are refused. The client opens a fresh MCP session for each cloud execution and renews access tokens without a laptop being present.

## 5. Test processing and QC without public posting

Keep `PUBLICATION_ENABLED=false`. Run `enableAutomaticWorkflow`; this validates your private folder, account allowlist, renewable authorisation and budget before enabling one five-minute timer.

In the Triggers page, set that timer's failure notification to **Notify me immediately**. File-specific errors also send mail to your configured address.

Now upload a short test video or move one into the monitored folder. Choose an informative filename: that becomes the title and supplies the text hook. Run `status` privately to follow its file ID, project, stage and result. Processing and QC are paid even while public posting is disabled.

A passing sample ends as `dry_run_complete`, with a notification confirming that no public posts were made. Watch its actual HD export in OpusClip to check your own footage, caption style, layout and hook position. The hook geometry was tested on one style; visual QC still has to pass for each new export.

## 6. Enable unattended publishing

After your own sample and destination checks pass, set `PUBLICATION_ENABLED=true` in Script Properties. This is a one-time activation; future passing videos need no per-video owner approval.

Add a fresh video to the folder. The dry-run sample remains terminal and is not silently reposted when you enable publishing. The worker uploads, edits, renders, checks and submits the new video to all four configured accounts. Completion requires provider-confirmed `posted` statuses and permalinks.

Run `status` privately and open all four platform links to verify your first real publication. Platform restrictions, disconnected accounts and provider changes may prevent publication even when editing and QC succeed.

## Pause and recover

Run `pauseAutomaticWorkflow` to stop new processing while preserving the ledger. Existing provider operations may already be running; pausing does not retract public posts or cancel provider tasks. To resume normal work, run `enableAutomaticWorkflow` again; it preserves the existing baseline and file records.

For an ambiguous submission or post, inspect the original recorded project/task before any retry. A reference-analysis timeout must be reconciled using its original job ID or identical stable idempotency key, not a newly paid request. An ambiguous refresh token rotation needs reconnecting rather than guessing which token remains valid. Do not delete ledger rows to force a rerun.

Use the private Apps Script execution log and provider account pages for debugging. In public bug reports, share a redacted error code and a synthetic example, never a live payload, token, signed URL, file ID or private log.
