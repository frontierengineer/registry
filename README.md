# The Frontier Registry

The central listing of Frontier Application Releases. Anyone can list an Application here, and no person reviews a listing: automated checks, hash pinning and a blocklist stand in for a gatekeeper.

The Registry is files, not a server. Frontier's Host reads them anonymously from `https://raw.githubusercontent.com/frontierengineer/registry/main/`, keeps each one for five minutes, and then asks again with the file's ETag, so a file that has not changed is not downloaded again. The Registry has no accounts and no publish tokens: a publisher is whoever owns the GitHub repository an Application is published from.

## What is here

| File | Written by | What it holds |
| --- | --- | --- |
| `listings/<id>.json` | the publisher, by pull request | `{ id, repository, commit }`: the Application and the commit to list. The Host never reads it. |
| `applications/<id>.json` | the pipeline | `{ id, repository, repositoryId, unpublished, releases }`: every Release the Registry ever listed, oldest first, kept after unpublishing. `repositoryId` is GitHub's numeric id for the repository it was first listed from. |
| `index.json` | the pipeline, and `report` by hand | `{ report, applications: [{ id, title, description, color, latest: { hash, listedAt, flags } }] }`: every listed Application at its latest Release, holding only what Browse shows and filters on, and `report`, the address where an install reports an Application. Every Host downloads it to browse, so it carries no contributions: those stay in `applications/<id>.json`, which a Host reads when it installs, resolves or checks for an update. The pipeline rebuilds `applications` and keeps every other field. |
| `checks/<commit hash>.json` | the pipeline | `{ repository, commitHash, outcome, reason, checkedAt }`: what the pipeline concluded of a commit, `listed` or `rejected` with the reason. |
| `blocklist.json` | a maintainer, by hand | `{ applications: [{ id, reason }], releases: [{ id, hash, reason }], publishers: [{ publisher, reason }] }` |
| `platform.json` | Frontier's release workflow | `{ builds: [{ buildId, publishedAt }] }`: the Platform builds published, one entry for each build of Frontier's main branch it publishes, pushed with a deploy key, so a Release is placed against them. |

An id is its repository's: `github.com/<owner>/<name>`. A Release is

```json
{
  "hash": "<40-character commit hash>",
  "sourceSha256": "<the source digest of the commit's files, 64 lowercase hex digits>",
  "listedAt": "<when the Registry listed it, ISO-8601 UTC>",
  "flags": ["<what the scan saw: network, processes, filesystem, dynamic code, obfuscation>"],
  "platformBuild": "<the newest Platform build when it was listed, or empty>",
  "contributions": { "...": "the Application's contributions.json at that commit" }
}
```

`sourceSha256` pins the Release's files. Frontier's Host installs a Release by downloading the gzipped tar GitHub serves for the commit at `https://codeload.github.com/<owner>/<name>/tar.gz/<hash>` over HTTPS, with no git, unpacking it, and refusing it unless its files have this digest. The digest is of the files alone, never of the archive's bytes: GitHub makes its archives as they are asked for and has changed their compression before, and a pin of the bytes would then refuse every install though no file changed.

The source digest is the SHA-256 of one record per regular file, in the order of their paths compared as UTF-8 bytes: `x` when the file is executable or `-` when not, a space, the SHA-256 of its bytes in lowercase hex, a space, its path relative to the Application's root with `/` between segments, and a NUL byte. Directories add nothing. The Application's root is the archive's top when `contributions.json` is there, and otherwise its one top-level directory, which is how GitHub's archives are laid out. An archive holding a link has no digest, and is refused. `pipeline/lib/source.mjs` computes it, and Frontier's Host and build compute the same, each held to the same test vector (in `pipeline/test/pipeline.test.mjs`). `node pipeline/bin/backfill-sources.mjs --root .` records it on any Release listed before the field existed.

A key a Release or an Application file holds that a Host does not know is read past, so adding a field never stops an installation that predates it.

A Release is a commit and nothing else. It has no version number: when the Registry listed it places it before or after another Release and every Platform build. That is the time the Registry listed its hash, never the commit's own timestamp. Once listed, a Release is never changed or removed.

## How a listing gets in

1. **Push the commit and open the listing pull request.** You, or an Agent working for you, push the Application to its GitHub repository and open a pull request here from your fork. Frontier itself does not publish: an Agent with your `git` and `gh` does. The pull request adds or replaces one file, `listings/<id>.json`, which names the repository and the commit hash.
2. **The pipeline checks it.** It reads the pull request as data, then clones, scans and builds the commit without running any of it. See [What the pipeline checks](#what-the-pipeline-checks).
3. **It lands or it is refused.**
   - **When every check passes,** the pipeline merges the pull request. In the same commit it writes the new Release into `applications/<id>.json`, `index.json` and `checks/<hash>.json`, and that moment is the Release's time. It comments on the pull request with any flags the scan raised. Installs see the Release within about ten minutes: GitHub caches the file for about five minutes, and each Host keeps it for five more.
   - **When a check fails,** the pipeline writes the reason to `checks/<hash>.json`, where you or your Agent can read it. It also comments the reason on the pull request and closes it. Fix the problem, push it, then open the listing pull request again with the new commit.

Every later Release goes the same way: a new pull request replaces your listing file with the new commit.

**Unpublishing.** Open a pull request that deletes your `listings/<id>.json`. Once it lands, the Application leaves Browse and new installs, and every Release it had stays recorded, so an install or an Application Set that names one can still reach it. Publishing again later lists it again.

## What the pipeline checks

The checks run in this order, and the first one that fails refuses the listing and gives the reason.

1. **One listing file.** The pull request changes only `listings/<id>.json`. It never touches the blocklist, `platform.json`, the generated files, or a second listing.
2. **The listing's shape.** The listing names exactly `id`, `repository` and `commit`, in at most 4 KiB.
   - The file is named for its id.
   - The commit is a full 40-character hash.
   - The id is the repository's id, the way Frontier derives it from any form of the URL.
   - The repository is on GitHub.
3. **The publisher owns the repository.** The pull request comes from the repository's owner. For an organization's repository, it comes from a public member of that organization. The repository must exist and be public, since every install downloads its source archive anonymously. It must also be the same GitHub repository the id was first listed from: GitHub's numeric repository id must match. A name taken over after its repository was deleted or moved cannot list under the old id, and cannot unpublish it either.
4. **The blocklist does not name it.** That covers the Application, the Release, and its publisher.
5. **The name is not a typosquat.** The id is not within typosquatting distance of an id another owner listed. "Distance" means either of these, compared without case and without `github.com/`:
   - the two ids are equal once characters that look alike (`0`/`o`, `1`/`l`/`i`, `5`/`s`, `rn`/`m`, `vv`/`w`) are folded together and `-`, `_` and `.` are dropped;
   - one id is a single edit from the other.

   An owner's own ids never conflict with each other.
6. **The commit is new.** It is not already a Release of this Application.
7. **The commit is the repository's own.** A branch or tag of the repository holds it. GitHub serves a fork's commits through the parent repository too, so the pipeline clones the repository and looks for the commit there.
8. **A sound Application.**
   - Its files come to at most 25 MiB, with no submodules.
   - `contributions.json` sits at its root, is at most 256 KiB, is valid as Frontier reads it, and declares the listing's id.
9. **Nothing published is broken.** Against the previous Release, nothing it published is removed, renamed or retyped. That covers:
   - every action, option source, modal, badge, method and workload by id;
   - every input field of an action, and every option of its runtime or configuration field of its workspace provisioner, by key and type;
   - each singular contribution it had;
   - the Application it stands in for;
   - the input and output fields a method or workload declares, if any. The Application Interface declares none today, so this applies only when a Contributions File does.

   Only the Contributions File is compared. Keeping what a method answers the same is its author's job.

   A field a caller could leave out must not become required, and a new field must not be required. A change that would break a caller is a new action or method under a new id, kept beside the old one.
10. **Its packages are as the Platform installs them.**
    - `package.json` comes with `package-lock.json`, or neither is there.
    - Every package resolves from `https://registry.npmjs.org/` with an integrity hash.
11. **No secrets.** No private key and no known token format (GitHub, AWS, Anthropic, OpenAI, Google, Slack, Stripe, npm) appears in any text file. If one did, it is already public, so revoke it before you publish again.
12. **It builds.** The pipeline builds the Application exactly as the Host does:
    - `npm ci`, with install scripts off;
    - esbuild bundles each `host`, `worker` and `surface` entry with the Host's options;
    - `translations.json` must be complete.

    The pipeline does not type-check, and it runs none of the Application's code or tests.
13. **Its source can be pinned.** The pipeline downloads the commit's source archive from GitHub and records the source digest of its files as the Release's `sourceSha256`. An archive holding a link is refused, since Frontier installs none. When the archive cannot be downloaded, the check cannot finish and nothing is listed; it runs again when the pull request is reopened.

**Flags.** The scan reads the built Bundles, which hold the Application's code and every package it uses. It records what it sees on the Release as flags, each a short word from a fixed list that Frontier words for the install prompt. A flag does not refuse a listing. The install prompt shows each flag, so a person decides with them in view. The flags are:

| Flag | What the Bundles do |
| --- | --- |
| `network` | reach the network: `fetch`, WebSocket, Node's `http`, `https`, `net`, `tls`, `dgram`, `dns` |
| `processes` | start processes or threads: `child_process`, `cluster`, `worker_threads` |
| `filesystem` | read or write files: Node's `fs` |
| `dynamic code` | run code built at run time: `eval`, `new Function`, `vm` |
| `obfuscation` | hold long encoded strings |

A listed Release is never scanned again, even when a new advisory names a package it uses: acting on an advisory is the Application's author's job. A Release found to be malicious is pulled with the blocklist.

## The blocklist

Only a person changes `blocklist.json`. A maintainer commits it directly or merges a pull request after reading it. The pipeline never writes it, and it refuses any listing pull request that touches it. The blocklist is the one lever that reaches every install. Within its daily check, every install:

- stops an Application the blocklist names,
- stops an Application that runs a blocklisted Release,
- stops every Application of a blocklisted publisher, such as `github.com/acme`.

To pull one bad Release, add a `releases` entry for it, and the Application's owner then lists a fixed later Release. Every entry should carry a reason: installs show it to the person.

## Reporting an Application

Open an issue with the **Report an Application** template. `index.json` names its address as `report`, so an install reports to the Registry it reads; Frontier reads it only when a person reports an Application. Add `application=<id>` and `release=<commit hash>` to that address to fill in the report's fields, for example `https://github.com/frontierengineer/registry/issues/new?template=report-an-application.yml&application=github.com/acme/notes&release=<hash>`. Reports are public. If a report describes a vulnerability others could exploit before a fix, send it privately through the repository's Security tab instead.

## Running the checks yourself

```sh
cd pipeline
npm ci --ignore-scripts
npm test                                      # the checks, and a dry run of the workflow against local repositories and a stand-in GitHub API
bash proof/host-reads.sh ../../frontier       # Frontier's own Registry reader against these files, over file:// and HTTP
```

To check one listing against a real repository:

```sh
echo '[{"status":"A","path":"listings/github.com/acme/notes.json"}]' > /tmp/changes.json
node bin/check.mjs --root .. --changes /tmp/changes.json --listing ../listings/github.com/acme/notes.json \
  --author acme --out /tmp/verdict.json
node bin/record.mjs --root .. --verdict /tmp/verdict.json      # writes the files a landing would
```

## Maintaining the repository

The workflow in `.github/workflows/listing.yml` runs three jobs:

- **read** holds a read-only token. It reads the pull request through GitHub's API, as data, and asks GitHub about the listed repository and the author.
- **check** holds no token and no credentials. It clones, scans and builds the Application, and replays what the read job learned.
- **land** holds a write token. It lands the verdict, and runs nothing but this repository's own code.

The workflow needs:

- **Workflow permissions:** "Read and write permissions". The workflow file narrows them per job.
- **Fork pull requests:** keep the default, which never gives a fork's workflow secrets. The workflow runs on `pull_request_target`, so it always runs the default branch's copy of itself and of the checker, never the pull request's.
- **Branch protection on `main`:** if pushes are restricted, allow GitHub Actions to push. The pipeline lands each verdict as one commit on `main`, and its push carrying the pull request's head is what GitHub records as the merge.

A maintainer changes the blocklist, the pipeline and this README by ordinary commits, and Frontier's release workflow adds to `platform.json`. A listing pull request can never change them.
