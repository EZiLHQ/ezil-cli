# Standalone Git supervisor contract v2

The public EZiL CLI can open a `github.ezil.work` repository using a short-lived Git credential issued by the gateway. This path uses the EZiL ID issuer and subject and the Cloudflare repository ID. It requires no Works account, project binding, stored CLI session, or application API request.

The authenticated supervisor obtains a packet from `POST https://github.ezil.work/v2/git/grant` with an EZiL ID bearer and JSON `{ "repoURL": "https://github.ezil.work/namespace/repository.git", "scope": "read" }`. Use `write` only when authorized. The gateway remains responsible for ownership and scope enforcement.

The supervisor starts:

```text
ezil clone https://github.ezil.work/namespace/repository.git --directory /absolute/checkout --json --grant-fd=3
```

Descriptor 3 must be an inherited anonymous pipe or socket. Write one UTF-8 JSON packet to it and close the writer. The packet is never an argument, environment variable, named file, URL, Git configuration, or log entry. Standard input is not used. The descriptor reader has a 16 KiB limit and a five second deadline. A small Node child reads the inherited descriptor through an anonymous pipe so cancellation works under both Bun and Node.

The exact packet shape is:

```typescript
{
  version: 2,
  repository: {
    id: string,           // exact Cloudflare repository ID
    canonicalURL: string,// exact https://github.ezil.work/namespace/repository.git
    ref: string          // full refs/heads/... branch
  },
  identity: {
    issuer: "https://id.ezil.work/",
    subject: string      // exact authenticated EZiL ID subject
  },
  git: {
    username: "ezil",
    token: string,       // opaque short-lived gateway Git credential
    expiresAt: string,  // UTC ISO timestamp, future and at most five minutes away
    scope: "read" | "write"
  }
}
```

Unknown fields are rejected at every level. Tokens use 16–8192 characters from the HTTP-safe alphabet `A-Za-z0-9._~+/=?-`, including the `?expires=` suffix in native Artifacts HTTP Basic passwords. Whitespace, controls, and colon remain rejected; a legacy token prefix is not required. Canonical URL spelling must match the command exactly. Credentials expire during an operation and are checked again before transport and before each Git credential request. The credential helper serves only the authorized HTTPS host and repository path through an ephemeral socket in a private directory.

The destination must be absolute, have a pre-created real parent directory, and contain no symlink components. A new clone uses a temporary sibling and an exclusive destination reservation. Git checks out the authorized branch even when the remote default branch differs; a tag with the same name cannot substitute for the branch.

A matching existing checkout returns `reused` after inspecting its exact origin URL and symbolic branch. Local commits, the index, dirty files, and untracked files are preserved. A different origin or branch is refused without modifying that checkout. Reuse does not fetch or reset.

Success is one JSON line:

```typescript
{
  canonicalUrl: string,
  folder: string, // actual absolute checkout folder
  repository: { id: string, canonicalURL: string, ref: string },
  identity: { issuer: "https://id.ezil.work/", subject: string },
  status: "cloned" | "reused"
}
```

Failure is `{ "error": { "code": string, "message": string } }` with a nonzero exit status. Messages never include the packet or credentials. Invalid arguments or unauthorized packets use exit status 2. Cancellation uses exit status 1.

The supervisor owns the operation process group. SIGTERM or SIGINT cancels the descriptor reader and waits for the Git child to close. A Git child that ignores cancellation is killed after 500 ms. Forced termination preserves uncertain temporary state and the destination lock for explicit recovery; the CLI never deletes another operation's state. The supervisor must reap any surviving descendants before recovery.

Source runs require Bun 1.3.14, Node 22+, and Git; the bundled package runs under Node 22+ and Git. Legacy clone, auth, and session commands keep their existing behavior. This standalone packet adds no Works wire-contract fields.
