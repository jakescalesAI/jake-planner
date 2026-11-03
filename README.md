# Planner

Jake's calendar and tasks in one Obsidian view, styled after Vault Claude (Apple's HIG). No build
step and no dependencies: `main.js`, `styles.css` and `manifest.json` are the plugin. Works on
desktop, iPad and iPhone.

The notes stay the source of truth, and the plugin keeps no data of its own.

| What | Reads | Writes |
| --- | --- | --- |
| Calendar | `0 Home/3 Schedule/Calendar.md` (calsync, next 14 days) | New events go under `## Events` in `Add to calendar.md`; calsync picks them up within 2 minutes |
| Tasks | Checkboxes anywhere in the vault, minus the folders Home leaves out | Ticking writes `- [x] ... ✅ date`; new tasks go to `0 Home/2 Tasks/Inbox.md` |
| From email | Plain bullets in `0 Home/2 Tasks/Email.md` | Book turns the bullet into a checkbox |

Every open note redraws by itself when a sync lands. A line is only edited if it still has the text
the plugin read, so a tick can't land on the wrong task.

## Install

Copy `main.js`, `styles.css` and `manifest.json` to `<vault>/.obsidian/plugins/jake-planner/`, then
turn on Planner under Settings → Community plugins. LiveSync's Customization Sync carries it to the
other devices.

## Test

```bash
node --check main.js
node test/core.test.cjs /root/obsidian-vault
```

`test/harness.cjs <vault> <out dir>` writes a page that runs the real plugin in a browser on a copy of
the notes; open it with `?run=1` to run `test/checks.js`, whose results land in `#result`. The copy holds private
notes, so keep the out dir outside this repo. Obsidian's API is stubbed there, so a change to how the
plugin talks to Obsidian still needs a look in the real app.

## Release

Bump `version` in `manifest.json` and add the same key to `versions.json` (`"x.y.z": "<minAppVersion>"`),
run the tests, then package and tag per AgentHub `skills/obsidian-plugin-release/SKILL.md`. Packages
land in `/root/backups/plugins/jake-planner-<version>/`. Tags stay local: pushing one is publishing.
