# AI Interaction Guide

## Anti-Dependency Strategies

### 1. Teach Patterns, Not Solutions
When asked "how do I add a new setting?", don't just write the code. Reference the Common Recipes in SKILL.md and explain the pattern (package.json ↔ configManager.ts sync) so the developer can apply it to similar tasks.

### 2. Encourage Self-Sufficiency
- Point to the [VS Code Extension API docs](https://code.visualstudio.com/api) for API details
- Reference existing code patterns in `src/` (e.g. an existing data reader before writing a new one)
- Explain the "why" behind patterns, not just the "what" — e.g. why `fileWatcher.ts` polls in addition to using `fs.watch`

### 3. Progressive Disclosure
- Start with the minimal correct answer
- Add detail only when asked or when complexity requires it
- Don't over-explain well-understood patterns

## Correction Protocol

When corrected:

1. **Acknowledge** the correction immediately
2. **Restate** the correct rule in your own words
3. **Apply** the correction to the current task
4. **Write** to LEARNED.md under `## Corrections` with date and rule

Example flow:
```text
User: "Don't add a setting to configManager.ts without also adding it to package.json"
AI: "Understood — every claudePulse.* setting needs a matching contributes.configuration
     entry in package.json, or VS Code's Settings UI won't show it even though
     configManager.ts would still read a default. Writing to LEARNED.md."
→ Writes: "- 2026-03-28: Never add a setting to configManager.ts without a matching
   contributes.configuration entry in package.json, and vice versa"
```

## Anti-Patterns in AI Assistance

### Don't Hallucinate APIs
- **Check**: Does this `vscode.*` API actually exist, and in the version this project targets (`engines.vscode: ^1.85.0`)?
- **Verify**: Is this method signature correct? (`@types/vscode` in `devDependencies` is the source of truth)
- **Reference**: INJECT.md "Do NOT Hallucinate" section before suggesting Chrome-extension concepts (manifest.json, chrome.*, service workers) — none of them apply here

### Don't Over-Engineer
- Don't add abstractions the project doesn't need
- Don't suggest architectural changes (e.g. a message bus, a state management library) when the existing `cachedData` + event-driven refresh pattern already does the job
- Match the project's existing complexity level

### Don't Skip Verification
- Always read the file before editing
- Always check `package.json` `contributes.configuration` before suggesting a new setting be read in `configManager.ts`
- Always check `types.ts` before touching any function that returns or consumes `ClaudePulseData`

## Proficiency Calibration

| Signal | Proficiency Level | Behavior |
|---|---|---|
| Asks about basic `vscode.*` APIs | Beginner | Explain concepts, link to VS Code API docs, provide examples |
| Asks about activation events or the Disposable pattern | Intermediate | Focus on this project's actual wiring in `extension.ts`, highlight the subscriptions pattern |
| Asks about performance or credential-handling security | Advanced | Technical analysis, trade-offs, refer to `references/` |
| Uses correct terminology, precise questions | Expert | Minimal explanation, direct implementation |

## Convention Surfacing

When discovering a new convention in the codebase:

1. Note it in your response
2. Write to LEARNED.md under `## Discovered Conventions`
3. Apply consistently in all future interactions
