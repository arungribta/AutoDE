---
name: autode-core-knowledge-articles
description: Write and maintain AutoDE knowledge articles - Markdown pages about assets, terms or domains that say what atomic facts can't (pitfalls, history, golden sources, how to reconcile), citing every fact they rest on - and update an article when a fact it cites is superseded or rejected. Use it when an asset needs explaining beyond its facts, or when a maintenance item says an article is stale.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_get_asset_context, mcp__autode__autode_search_assets, mcp__autode__autode_search_articles, mcp__autode__autode_propose_article]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Knowledge articles

An article lives in `.autode/knowledge/articles/<slug>.md`. It is **about** assets, terms or domains (their ids), and it **cites** the facts it rests on. Once a person approves it, agents get it in the packs of tasks over what it is about. When a fact it cites is superseded or rejected, the article goes stale and stays out of packs until it is updated.

## 1. Is an article the right thing?

- A single claim (a key, a grain, a rule, a definition) is a fact: propose the fact, not an article.
- An article is for what connects facts or explains them: why the table has two customer ids, which source is the golden one, how two systems' revenue reconcile, the pitfalls of a column, the history of a change.
- `autode_search_articles` first: update an existing article rather than writing a second one on the same subject.

## 2. Gather what is known

`autode_get_asset_context` for each asset it is about gives its facts, rules, quality checks and existing articles. `autode_list_assertions` finds the rest. Cite only facts that are confirmed or documented. A proposed fact may be cited, but say that it is unconfirmed.

## 3. Write

- A title that says what the reader learns ("Why orders has two customer ids"), not just the asset's name.
- Short sections in plain language. Each claim that rests on a fact carries `[fact:<id>]` in the text, and every cited id is in `cites`.
- Name the golden source, the pitfalls, and what to do about them. Leave out what a fact already says on its own.

## 4. Propose

`autode_propose_article` with `slug`, `title`, `about`, `cites` and `body`, plus `domain` and `tags` if known. A person approves it.

## 5. A stale article

The maintenance item lists what changed (`<fact> was superseded by <fact>: "<statement>"`).
1. Read the new facts.
2. Rewrite what they change, and replace the old ids with the new ones in the text and in `cites`.
3. Propose it again under the same slug. If the article no longer makes sense, say so in your summary: a person deprecates it.

## Rules

- Never restate a fact without citing it, and never cite a fact for something it doesn't say.
- Never approve an article yourself.
