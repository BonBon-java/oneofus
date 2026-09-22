# ONEOFUS

Static landing page for ONEOFUS.

## Local preview

No dependencies or build step are required.

```sh
python3 -m http.server 4174
```

Then open <http://127.0.0.1:4174/>.

## Checks

The current payment flow is UI-only. It does not contact exchanges, submit
transactions, or verify payments. `payment-config.js` keeps the published site
in an explicit demo mode with an intentionally invalid recipient address.
The draw countdown is calculated from the next `00:00 UTC` on every update.

Run the dependency-free logic tests with:

```sh
node --test tests/*.test.js
```

## GitHub Pages

The workflow in `.github/workflows/pages.yml` packages the production HTML,
CSS, JavaScript, favicon, and optimized images, then deploys the artifact to
GitHub Pages after every push to `main`.

All site assets use relative paths, so the landing page works from a project
repository path such as `/oneofus/` and remains compatible with a future
custom domain.

For the first deployment, open the repository's **Settings → Pages** and set
**Source** to **GitHub Actions**.
