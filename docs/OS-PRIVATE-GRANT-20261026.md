# OS private repository grant adapter (Works v1.1)

Owned additive adapter on reviewed ee2e552; no login, API audience, gateway or persistent credential changes.

`ezil clone <canonicalURL> --directory <absoluteDestination> --json --grant-fd=3`

FD 3 must be an inherited anonymous pipe or socket, not a regular file. It contains one JSON object (max 16384 bytes, EOF, five-second input deadline):

```
{version:1,binding:{projectId,repositoryId,canonicalURL,ref,bindingVersion},
 identity:{issuer:"https://id.ezil.work/",subject},
 git:{username:"ezil",token,expiresAt,scope:"read"}}
```

The packet is the validated Works v1.1 redemption plus `version:1`. The OS verifies its original Auth0 session and computer ownership, redeems with `userIdToken`, checks exact issuer/subject, and validates expiry bounded by the ID token and five minutes. The private control channel binds the entire runtime body to the owned computer. CLI validates exact canonical URL, packet shape, read scope and expiry before clone/reuse. The adapter performs no CLI login/store access/whoami/grant request. Token is never an option, environment value, file, URL, stdout or diagnostic. Only the inherited descriptor number appears in argv. Existing Git credential helper socket enforces exact route and expiry.

Success for this additive mode: `{canonicalUrl,folder,identity:{issuer,subject},status:"cloned"|"reused"}`. It intentionally does not fabricate a Works `accountId`: the authority contract supplies no account ID. Existing non-FD clone JSON remains unchanged. Existing error envelope/exit codes and process-group cancellation/recovery remain unchanged. Expired grants fail closed, including reuse; no pull/reset/checkout modifies a reused folder.

OS Python subreaper explicitly passes FD 3, closes its copy after spawn, and keeps the same 3000ms group cleanup grace. CLI closes its input before Git runs. Forced recovery never removes uncertain files.

Validation: 48 Git tests and CLI typecheck; OS packaged integration covers both legacy and private FD paths, credential helper retrieval, no login/API calls, exact folder/fixture, dirty reuse, normal timeout/retry, CLI escalation, OS forced termination, process metadata secret containment and unrelated/unknown state preservation. Runtime artifact requires independent exact review before staging use. No public publication or deployment.

## P1 authoritative-ref repair (v6)

The private packet's full `refs/heads/...` ref now reaches the Git transport. Fresh clones explicitly request that branch with single-branch/no-tags and verify symbolic HEAD equals the full authoritative ref and its commit equals the exact origin tracking ref before publishing the destination. A tag-only name cannot satisfy the contract; a same-basename tag cannot substitute its commit. Reuse requires the existing symbolic HEAD to match the full ref. Ref mismatch returns `repository-ref-mismatch` without checkout/reset/pull, preserving local commits, dirty/untracked files and the original branch. Real-Git regression exercises remote HEAD on main, a distinct topic branch and same-name tag, tag-only refusal, successful same-ref reuse and mismatched-ref preservation. CLI targeted Git suite: 49 tests and CLI typecheck pass. New package version: 0.2.1-repo-url-open.20261026.6; requires narrow rereview.
