# pi-link-sessions

Pi package that adds a `/link-sessions` command which allows you to easily choose and link a session from another folder to the current session via symlink.

It will not destroy session directories not owned by the current session and warns when the current session directory already contains sessions which should be replaced (linked).

## Why?

Sessions are tied to filesystem paths.  If you're syncing your sessions across machines your working paths may well differ. Now you can easily find and link the sessions you need.

## Install

### Project-local

```bash
pi install -l .
```

### Global

```bash
pi install .
```

### From git

```bash
pi install git:github.com/<you>/pi-link-sessions
```

## Usage

In pi, run:

```text
/link-sessions
```

If pi is already running after install, run `/reload` once.

## Testing

```bash
npm test
```
