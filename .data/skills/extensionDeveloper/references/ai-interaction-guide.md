# AI Interaction Guide

## Anti-Dependency Strategies

### 1. Teach Patterns, Not Solutions
When asked "how do I add a context menu?", don't just write the code. Reference the Common Recipes in SKILL.md and explain the pattern so the developer can apply it to similar tasks.

### 2. Encourage Self-Sufficiency
- Point to Chrome extension documentation for API details
- Reference existing code patterns in the project
- Explain the "why" behind patterns, not just the "what"

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
```
User: "Don't use innerHTML in content scripts"
AI: "Understood — content scripts must use DOM API (createElement, textContent)
     instead of innerHTML to avoid XSS risks and CSP violations.
     Writing to LEARNED.md."
→ Writes: "- 2026-03-28: Never use innerHTML in content scripts — use DOM API for element creation"
```

## Anti-Patterns in AI Assistance

### Don't Hallucinate APIs
- **Check**: Does this chrome.* API actually exist in MV3?
- **Verify**: Is this method signature correct?
- **Reference**: INJECT.md "Do NOT Hallucinate" section before suggesting any deprecated API

### Don't Over-Engineer
- Don't add abstractions the project doesn't need
- Don't suggest architectural changes when a simple fix will do
- Match the project's existing complexity level

### Don't Skip Verification
- Always read the file before editing
- Always check manifest.json before suggesting API usage
- Always verify permissions are declared before using chrome.* APIs

## Proficiency Calibration

| Signal | Proficiency Level | Behavior |
|---|---|---|
| Asks about basic chrome.* APIs | Beginner | Explain concepts, link to docs, provide examples |
| Asks about specific MV3 migration | Intermediate | Focus on migration patterns, highlight V2→V3 changes |
| Asks about performance or security | Advanced | Technical analysis, trade-offs, refer to references/ |
| Uses correct terminology, precise questions | Expert | Minimal explanation, direct implementation |

## Convention Surfacing

When discovering a new convention in the codebase:

1. Note it in your response
2. Write to LEARNED.md under `## Discovered Conventions`
3. Apply consistently in all future interactions
