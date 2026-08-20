# Security policy

## Supported versions

Until Pi Reads reaches 1.0, security fixes are applied to the latest release and the `main` branch. Older Git tags may not receive backports.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button when private vulnerability reporting is enabled for the repository. If it is unavailable, contact the maintainer through a private channel listed on the [`@revazi`](https://github.com/revazi) profile before sharing details.

Do not open a public issue for a suspected vulnerability and do not include credentials, Kindle addresses, private article content, or SMTP transcripts in a report. A minimal synthetic reproduction is preferred.

You should receive an acknowledgement within seven days. We will coordinate validation, a fix, and disclosure timing with the reporter. Please allow time for a patch before publishing details.

## Sensitive-data boundary

Pi Reads is designed so that:

- captured sources, generated articles, and exports live outside the installed package by default;
- copied article bodies, raw HTML, PDFs, EPUBs, and local credentials are not committed;
- SMTP credentials and full Kindle/sender addresses remain environment values;
- Kindle email requires an interactive confirmation;
- archived source prose is immutable and kept separate from generated prose.

See [the product contract](docs/product-contract.md) and [EPUB and Kindle delivery](docs/epub-and-kindle.md) for the complete trust boundary.
