# Privacy and publication boundaries

This repository is a fresh public reference copy. It does not include the operational repository's commit history, personal author email, source footage, Drive identifiers, deployment IDs, social account identifiers, live status ledgers, platform task receipts or token stores. Test fixtures are synthetic.

## Where private data belongs

Real configuration, API credentials, OAuth access/refresh tokens, resumable session URLs and file/project tracking records belong only in the adopter's private Google Apps Script project. Script Properties are readable by project editors. Keep that editor list limited to people authorised to see these values.

Drive files stay private. The worker reads them with the owner's read-only OAuth grant and sends authorised footage to the owner's OpusClip workspace for processing. Finished exports are also sent to OpusClip's media-understanding service for picture and sound QC. Passing videos are then publicly posted to the explicitly configured social accounts. This is intentional publication of the video, not publication of the source folder or credentials.

Neither GitHub nor a laptop runs the production worker. GitHub CI runs offline software tests with no live accounts and needs no production secrets.

## Before making your own copy public

Check every tracked file and every reachable commit, branch, tag, pull request, workflow log and artifact. Deleting a secret from the newest file does not remove it from history. Prefer a fresh, reviewed reference copy over changing an operational repository's visibility.

Use a GitHub no-reply address for public commit authorship. Check commit metadata as well as source contents. If a credential was ever exposed, rotate it at its provider; rewriting history alone is not a replacement for rotation.

The included privacy tests detect some common mistakes, including committed private settings, real-looking media identifiers, personal contact addresses and credential formats. They complement manual review and cannot prove that arbitrary future contributions contain no private information.

## Scope of automated checks

Rendered-media QC checks technical presentation and correspondence with intended settings. It does not provide a legal review, verify factual claims, assess permissions to use somebody else's footage, or establish that a text hook will improve engagement. It does not include a vidIQ analytics feedback loop.
