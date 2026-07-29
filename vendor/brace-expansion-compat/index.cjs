'use strict'

// brace-expansion 5 made its CommonJS export an object. Older minimatch
// releases used by Electron's packaging graph require the historical callable
// export. Keep the fixed upstream implementation while presenting both shapes.
const modern = require('brace-expansion-modern')
const expand = modern.expand

if (typeof expand !== 'function') {
  throw new TypeError('brace-expansion-modern did not expose expand()')
}

module.exports = expand
module.exports.expand = expand
module.exports.EXPANSION_MAX = modern.EXPANSION_MAX
module.exports.EXPANSION_MAX_LENGTH = modern.EXPANSION_MAX_LENGTH
