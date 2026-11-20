# Manuscript Formatter

An open-source, privacy-focused browser tool for preparing complete research manuscripts for journal submission.

## Website

https://geopromilton.github.io/manuscript-formatter/

## Features

- DOCX, PDF, TXT, and LaTeX manuscript upload
- Automatic title, author, abstract, keyword, section, and reference detection
- Total and per-section word counts
- Presets for 29 journal/publisher families, including Nature, PNAS, IEEE, SAGE, MDPI, AGU, Elsevier, Wiley, Springer, Taylor & Francis, Frontiers, PLOS, BMC, OUP, Cambridge, ACS, and others
- DOCX, PDF, TXT, and LaTeX export with preset font, size, spacing, and margin settings
- Live formatted preview and explicit submission-readiness checks
- IndexedDB autosave with unsaved-change warnings
- Keyboard-operable upload step and ARIA tab navigation
- Browser-only file processing

## Development

```bash
npm ci
npm run dev
npm run build
npm test
npm run lint
```

Publisher presets include a source link and a checked date where a reliable publisher guideline page could be mapped. They remain starting defaults, not substitutes for a journal's current official instructions. Citation styles are identified but references are not automatically rewritten.

## License

MIT
