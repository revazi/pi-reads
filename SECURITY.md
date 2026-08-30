# Security policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch. Older Git tags may not receive backports.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow:

<https://github.com/revazi/pi-reads/security/advisories/new>

Do not open a public issue for a suspected vulnerability and do not include credentials, Kindle addresses, private article content, or SMTP transcripts in a report. A minimal synthetic reproduction is preferred.

You should receive an acknowledgement within seven days. We will coordinate validation, a fix, and disclosure timing with the reporter. Please allow time for a patch before publishing details.

## Sensitive-data boundary

Pi Reads is designed so that:

- captured sources, generated articles, and exports live outside the installed package by default;
- copied article bodies, raw HTML, PDFs, EPUBs, and local credentials are not committed;
- SMTP credentials and full Kindle/sender addresses remain protected operating-system credential values or explicit environment overrides;
- Kindle email requires an interactive confirmation;
- archived source prose is immutable and kept separate from generated prose;
- remote article and image requests reject embedded credentials, private/non-routable IPv4 and IPv6 destinations, and unsafe redirects before each request;
- article HTML requests enforce a 20-second timeout, at most five redirects, and a 10 MiB buffered-response limit.

See [the product contract](docs/product-contract.md) and [EPUB and Kindle delivery](docs/epub-and-kindle.md) for the complete trust boundary.
