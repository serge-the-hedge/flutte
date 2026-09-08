# Agent Translation Guide

Start with the task-specific [portable agent kit](../agent-kit/README.md):

- [Context](../agent-kit/blabla-context/SKILL.md): inspect voice, terminology, examples, and unfinished work.
- [Translation](../agent-kit/blabla-translate/SKILL.md): submit candidates for existing or configured new languages.
- [Independent review](../agent-kit/blabla-review/SKILL.md): assess another agent's exact candidate under human authorization.
- [Dictionary](../agent-kit/blabla-dictionary/SKILL.md): maintain shared terms with explicit write scope.

Detailed transport and endpoint contracts live in the kit's
[canonical HTTP reference](../agent-kit/_blabla/references/api.md).
[Independent agent review](agent-review.md) remains the normative authority for
review enablement, separate agents and credentials, and review evidence.
Repository synchronization and CLI delivery use the separate
[Repository Adapter contract](repository-adapter.md).

The headings below preserve existing links to this former guide.

## Human Setup

[HTTP reference](../agent-kit/_blabla/references/api.md#human-setup).

## Preferred Agent Workflow

[Translation skill](../agent-kit/blabla-translate/SKILL.md).

### New-Locale Translation Task

[HTTP reference](../agent-kit/_blabla/references/api.md#new-locale-translation-task).

## Independent Reviewer Agent workflow

[Independent review skill](../agent-kit/blabla-review/SKILL.md).

## Translation Rules

[HTTP reference](../agent-kit/_blabla/references/api.md#translation-rules).

## Scopes

[HTTP reference](../agent-kit/_blabla/references/api.md#scopes).

## Endpoints

[HTTP reference](../agent-kit/_blabla/references/api.md#endpoints).

### `GET /projects/current`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-projectscurrent).

### `GET /workspace/search`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-workspacesearch).

### `POST /proposal-examples/search`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-proposal-examplessearch).

### `POST /guidance/context`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-guidancecontext).

### Dictionary authoring workflow

[Dictionary skill](../agent-kit/blabla-dictionary/SKILL.md).

### `GET /dictionary`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-dictionary).

### `POST /dictionary/terms`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-dictionaryterms).

### `DELETE /dictionary/terms`

[HTTP reference](../agent-kit/_blabla/references/api.md#delete-dictionaryterms).

### `GET /workspace/work`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-workspacework).

### `GET /workspace/ordinary-confirmations`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-workspaceordinary-confirmations).

### `POST /workspace/context`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-workspacecontext).

### `POST /translation-proposals`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-translation-proposals).

### `POST /translation-tasks`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-translation-tasks).

### `GET /translation-tasks`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-translation-tasks).

### `GET /translation-tasks/:id`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-translation-tasksid).

### `POST /translation-tasks/:id/candidates`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-translation-tasksidcandidates).

### `POST /translation-proposals/:id/candidate-revisions`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-translation-proposalsidcandidate-revisions).

### `GET /translation-proposals/:id`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-translation-proposalsid).

### `GET /translation-proposals/:id/candidates`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-translation-proposalsidcandidates).

### Retired catalog endpoints

[HTTP reference](../agent-kit/_blabla/references/api.md#retired-catalog-endpoints).

<a id="portuguese-locale-proposal"></a>

### Locale Proposal endpoints

[HTTP reference](../agent-kit/_blabla/references/api.md#locale-proposal-endpoints).

#### `POST /locale-proposals`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-locale-proposals).

#### `GET /locale-proposals?proposalId=...`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-locale-proposalsproposalid).

#### `GET /locale-proposals/template?proposalId=...&cursor=0&limit=16`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-locale-proposalstemplateproposalidcursor0limit16).

#### `POST /locale-proposals/values`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-locale-proposalsvalues).

#### `GET /locale-proposals/values?proposalId=...&cursor=0&limit=16`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-locale-proposalsvaluesproposalidcursor0limit16).

#### `POST /locale-proposals/finalize`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-locale-proposalsfinalize).

#### `GET /locale-proposals/artifact?proposalId=...`

[HTTP reference](../agent-kit/_blabla/references/api.md#get-locale-proposalsartifactproposalid).

## Existing-locale delivery

[HTTP reference](../agent-kit/_blabla/references/api.md#existing-locale-delivery).

### `POST /export`

[HTTP reference](../agent-kit/_blabla/references/api.md#post-export).
