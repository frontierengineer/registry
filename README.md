# The Frontier Registry

The central listing of Frontier Application Releases. Anyone can list an Application here, and no person reviews a listing: automated checks, hash pinning and a blocklist stand in for a gatekeeper.

The Registry is files, not a server. Frontier's Host reads them anonymously from `https://raw.githubusercontent.com/frontierengineer/registry/main/`, and keeps each one for five minutes. The Registry has no accounts and no publish tokens: a publisher is whoever owns the GitHub repository an Application is published from.

## What is here

| File | Written by | What it holds |
| --- | --- | --- |
| `listings/<id>.json` | the publisher, by pull request | `{ id, repository, commit }`: the Application and the commit to list. The Host never reads it. |
| `applications/<id>.json` | the pipeline | `{ id, repository, unpublished, releases }`: every Release the Registry ever listed, oldest first, kept after unpublishing. |
| `index.json` | the pipeline | `{ applications: [{ id, repository, title, description, color, latest }] }`: every listed Application at its latest Release. Browse reads this. |
| `checks/<commit hash>.json` | the pipeline | `{ repository, commitHash, outcome, reason, checkedAt }`: what the pipeline concluded of a commit, `listed` or `rejected` with the reason. |
| `blocklist.json` | a maintainer, by hand | `{ applications: [{ id, reason }], releases: [{ id, hash, reason }], publishers: [{ publisher, reason }] }` |
| `platform.json` | a maintainer, by hand | `{ builds: [{ buildId, publishedAt }] }`: the Platform builds published, so a Release is placed against them. |

An id is its repository's: `github.com/<owner>/<name>`. A Release is

```json
{
  "hash": "<40-character commit hash>",
  "listedAt": "<when the Registry listed it, ISO-8601 UTC>",
  "flags": ["<what the scan saw, in the Registry's words>"],
  "platformBuild": "<the newest Platform build when it was listed, or empty>",
  "contributions": { "...": "the Application's contributions.json at that commit" }
}
```

A Release is a commit and nothing else. It has no version number: when the Registry listed it places it before or after another Release and every Platform build. That is the time the Registry listed its hash, never the commit's own timestamp. Once listed, a Release is never changed or removed.

## How a listing gets in

1. **Publish from Frontier.** Frontier pushes the Application to its repository and opens a pull request here from your fork. The pull request adds or replaces one file, `listings/<id>.json`, which names the repository and the commit hash. You can also open that pull request by hand.
2. **The pipeline checks it.** It reads the pull request as data, then clones, scans and builds the commit without running any of it. See [What the pipeline checks](#what-the-pipeline-checks).
3. **It lands or it is refused.**
   - **When every check passes,** the pipeline merges the pull request. In the same commit it writes the new Release into `applications/<id>.json`, `index.json` and `checks/<hash>.json`, and that moment is the Release's time. It comments on the pull request with any flags the scan raised. Installs see the Release within about ten minutes: GitHub caches the file for about five minutes, and each Host keeps it for five more.
   - **When a check fails,** the pipeline writes the reason to `checks/<hash>.json`, where your Frontier reads it. It also comments the reason on the pull request and closes it. Fix the problem, then publish again, which opens a new pull request.

Every later Release goes the same way: publishing again replaces your listing file with the new commit.

**Unpublishing.** Open a pull request that deletes your `listings/<id>.json`. Once it lands, the Application leaves Browse and new installs, and every Release it had stays recorded, so an install or an Application Set that names one can still reach it. Publishing again later lists it again.

## What the pipeline checks

The checks run in this order, and the first one that fails refuses the listing and gives the reason.

1. **One listing file.** The pull request changes only `listings/<id>.json`. It never touches the blocklist, `platform.json`, the generated files, or a second listing.
2. **The listing's shape.** The listing names exactly `id`, `repository` and `commit`, in at most 4 KiB.
   - The file is named for its id.
   - The commit is a full 40-character hash.
   - The id is the repository's id, the way Frontier derives it from any form of the URL.
   - The repository is on GitHub.
3. **The publisher owns the repository.** The pull request comes from the repository's owner. For an organization's repository, it comes from a public member of that organization. The repository must exist and be public, since every install clones it anonymously.
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
   - the Application it stands in for.

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

**Flags.** The scan reads the built Bundles, which hold the Application's code and every package it uses. It records what it sees on the Release as flags. A flag does not refuse a listing. The install prompt shows each flag, so a person decides with them in view. The flags are:

- **reaches the network**
- **starts processes**
- **reads or writes files**
- **runs code it builds at run time**
- **holds encoded data it may run**

A listed Release is never scanned again, even when a new advisory names a package it uses: acting on an advisory is the Application's author's job. A Release found to be malicious is pulled with the blocklist.

## The blocklist

Only a person changes `blocklist.json`. A maintainer commits it directly or merges a pull request after reading it. The pipeline never writes it, and it refuses any listing pull request that touches it. The blocklist is the one lever that reaches every install. Within its daily check, every install:

- stops an Application the blocklist names,
- stops an Application that runs a blocklisted Release,
- stops every Application of a blocklisted publisher, such as `github.com/acme`.

To pull one bad Release, add a `releases` entry for it, and the Application's owner then lists a fixed later Release. Every entry should carry a reason: installs show it to the person.

## Reporting an Application

Open an issue with the **Report an Application** template. Reports are public. If a report describes a vulnerability others could exploit before a fix, send it privately through the repository's Security tab instead.

## Running the checks yourself

```sh
cd pipeline
npm ci --ignore-scripts
npm test                                      # the checks, and a dry run of the workflow against local repositories
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

The workflow in `.github/workflows/listing.yml` needs:

- **Workflow permissions:** "Read and write permissions". The workflow file narrows them per job. The checking job holds a read-only token. Only the landing job writes, and it runs nothing but this repository's own code.
- **Fork pull requests:** keep the default, which never gives a fork's workflow secrets. The workflow runs on `pull_request_target`, so it always runs the default branch's copy of itself and of the checker, never the pull request's.
- **Branch protection on `main`:** if pushes are restricted, allow GitHub Actions to push. The pipeline lands each verdict as one commit on `main`, and its push carrying the pull request's head is what GitHub records as the merge.

A maintainer changes the blocklist, `platform.json`, the pipeline and this README by ordinary commits. A listing pull request can never change them.
