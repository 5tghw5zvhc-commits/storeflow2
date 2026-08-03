# Deployment

## GitHub Pages

The repository contains `.github/workflows/pages.yml`. It validates the required files and deploys the repository as a static site.

The manifest and application assets use relative paths, so the app works from a project URL such as:

```text
https://USERNAME.github.io/storeflow/
```

## Cloudflare Pages

The same repository can be connected to Cloudflare Pages:

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `/`

## Publishing updates

Any push to `main` triggers GitHub Pages deployment. When changing cached static assets, increment `CACHE_NAME` in `sw.js` so installed devices refresh their app shell.
