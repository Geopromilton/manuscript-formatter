import {
  buildPreflightDiagnostics,
  buildSemanticDocument,
  countWords,
} from '../lib'

self.onmessage = ({ data }) => {
  const { type, manuscript, profile, assets } = data
  if (type !== 'analyze') return

  self.postMessage({
    type: 'analysis',
    semanticDocument: buildSemanticDocument(manuscript),
    diagnostics: buildPreflightDiagnostics(manuscript, profile, assets),
    totalWords: Object.values(manuscript).reduce(
      (total, value) => total + countWords(value),
      0,
    ),
  })
}
