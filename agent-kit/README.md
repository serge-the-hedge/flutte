# Blabla skills for coding agents

A portable skill bundle for agents with terminal access. It uses the existing
HTTP Agent API for App translations and directly authored content collections;
no MCP server or hosted agent runtime is required.

| Skill | Assignment |
| --- | --- |
| [blabla-context](blabla-context/SKILL.md) | Find established wording, terms, voice guidance, and reviewed examples |
| [blabla-translate](blabla-translate/SKILL.md) | Translate/correct task messages or prepare a configured language |
| [blabla-review](blabla-review/SKILL.md) | Independently review exact authorized revisions |
| [blabla-dictionary](blabla-dictionary/SKILL.md) | Deliberately maintain active shared terminology |

## Install into the consumer's workspace

Requirements: Node.js 22+ and an agent host that loads `SKILL.md` folders and can
run terminal commands. From a trusted checkout of this repository, choose the
skills directory recognized by your host:

```sh
node scripts/install-agent-kit.mjs --to /absolute/path/to/application/.agents/skills
```

The installer copies all four skill directories plus `_blabla`, which contains
the one shared helper and reference set. Keep those five directories together;
copying or installing an individual skill alone is unsupported. The installed
bundle needs no Blabla checkout, package installation, or network dependency to
run its helper. Installation makes no API calls.

Use the same command with `--replace` to deliberately update these bundle
folders; back up local edits first. Other skills are untouched. Rerunning after an
interrupted update recovers the prior bundle (or keeps a completed update) before
applying normal overwrite checks. If recovery evidence is invalid, the installer
stops and preserves it for inspection. Pick a reviewed
commit/tag of this repository when distributing a pinned version. Reload your
agent's skill catalog using its normal mechanism after installation.

Configure `BLABLA_AGENT_URL` and `BLABLA_AGENT_TOKEN` in the agent's environment.
See [transport](_blabla/references/transport.md) for connection details and
[Human Setup](_blabla/references/api.md#human-setup) for token scopes. Credentials
are never installed with the bundle. A translating agent and an independent
reviewer must have separate sessions and credentials; installing the review skill
does not grant permission to review.

Start with assignments such as “Find our established German wording for this
message,” “Translate task …,” or “Review candidate revision … independently.”

Live project Voice Guides, optional Locale add-ons, and Dictionary terms are
retrieved from Blabla. They are not copied into this bundle. Repository delivery
continues through the [local CLI](https://github.com/serge-the-hedge/flutte/blob/main/cli/README.md).

## Maintainer checks

Run `bun run test:agent-kit` for the local HTTP/installation tests and JavaScript
type checking. The suite uses local fixtures and temporary directories; it does
not seed a hosted Convex deployment or install into a real agent configuration.
