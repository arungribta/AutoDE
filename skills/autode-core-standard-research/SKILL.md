---
name: autode-core-standard-research
description: Research an industry standard AutoDE doesn't know yet (CIM, BIAN, ACORD, HL7 FHIR, ISO 20022, GS1, a house ontology) and propose its definition for the team's standards catalog - where its machine-readable release is, its licence, a pinned release, which reader fits and the settings for its quirks - for a person to try and approve. Use it when a business problem needs meaning from a standard the catalog lacks.
allowed-tools: [Read, WebSearch, WebFetch, mcp__autode__autode_ontology_standards, mcp__autode__autode_ontology_browse, mcp__autode__autode_propose_standard, mcp__autode__autode_ontology]
metadata:
  scope: core
  stageKinds: [ontology-alignment]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Researching a standard

A standard in AutoDE's catalog is a small definition (`autode: standard/1`): who publishes it, its industry, its licence, the release it is pinned to, where its files are, and how to read them. AutoDE reads OWL, RDFS and SKOS (Turtle or RDF/XML) and OpenAPI or JSON Schema. You find the facts with your own web tools; AutoDE never searches the web, and it fetches a standard only when a person asks.

If your host has no web tools, say so and ask the user for the publisher's page, the repository and the licence.

## 1. Is it already there?

`autode_ontology_standards` lists the catalog (FIBO, CIM as CGMES, BIAN and the team's), with proposals waiting. Don't propose a duplicate.

## 2. Find the machine-readable release

Search for the publisher's own release, not a blog's copy: "<standard> RDF", "<standard> OWL download", "<standard> OpenAPI GitHub". What AutoDE has met so far:

| Standard | Machine-readable form | Where |
|---|---|---|
| FIBO | OWL in RDF/XML, quarterly tags `master_YYYYQn` | github.com/edmcouncil/fibo |
| CIM (CGMES) | RDFS 2020 in RDF/XML, one file per profile | github.com/entsoe/CGMES-AP, folder `CGMES/RDFS` (no tags: pin a commit) |
| BIAN | OpenAPI 3 Semantic APIs, one file per service domain | github.com/bian-official/public, folders `releaseNN.0.0/semantic-apis/oas3/yamls` |

Prefer the publisher's repository: it is versioned, so the release can be pinned. Use its API to check (GitHub: `/repos/<o>/<r>`, `/tags`, `/releases`, `/git/trees/<ref>?recursive=1` for the files and sizes, `/commits/<branch>` for a commit id).

## 3. Check the licence

Read the repository's LICENSE and any NOTICE, and the files' own statements (`dct:license`, `dc:rights`, `info.license`). Set `redistribution`:
- `allowed`: MIT, Apache-2.0, BSD, CC BY, CC0;
- `forbidden`: "all rights reserved", "internal use only", a paid standard's text;
- `unknown`: anything you can't confirm. What is onboarded from it then stays in the workspace.

A standard sold by its body (IEC, ISO) may still publish free vocabularies (ENTSO-E's CGMES under Apache-2.0): say which part the licence covers.

## 4. Pin the release and choose the folders

`release.ref` is a tag, or a full 40-character commit id when there are no tags. `source.path` is the folder (or list of folders) that holds the files: AutoDE fetches only those. Keep within AutoDE's limits (2 000 files, 30 MB, 5 MB a file). A folder name the operating system can't hold (BIAN's release 14 `oas3 ` ends in a space) can't be read on Windows: choose another release.

## 5. Reader settings for its quirks

Look at a sample file. Settings, all optional:

| Setting | When | Example |
|---|---|---|
| `prefix` | always | `cim`, `bian` |
| `skipClasses` | the standard's datatypes or enumerations are classes | CIM: `{ property: <cims:stereotype IRI>, value: '(CIMDatatype\|Primitive\|enumeration\|Compound)$' }` |
| `skipProperties` | some properties aren't used | CIM: `cims:AssociationUsed` `^No$` |
| `cardinalityProperty` | multiplicities are on a property of their own | CIM: `cims:multiplicity` (`M:0..n`) |
| `conceptFormat`, `datatypeFormat`, `enumName` | API schemas mark business objects | BIAN: `class`, `datatype`, `values$` |
| `labelCase: title` | labels are lower case | FIBO |

## 6. Propose

Write the definition (the shipped ones in `ontologies/standards/` are examples) and `autode_propose_standard` with it and a `reason`: why the team needs it, and where you checked each part (pages, the LICENSE, the tag or commit). Tell the user to try it (Ontology view, Standards: **Try it**, which fetches it) and approve it. Then onboard from it (autode-core-ontology-onboarding).

## Rules

- Propose; never approve, and never make AutoDE fetch: a person does.
- Every fact in the definition comes from a page or file you read; what you couldn't confirm is `unknown` and said in the reason.
- Pin a release. A branch moves; a definition that moves can't be reviewed.
