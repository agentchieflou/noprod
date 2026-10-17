import './index.css'
import { missingFeatures } from './platform/support'
import { showUnsupported } from './platform/unsupported'

// The audio engine creates its AudioContext when it loads, so it loads only
// once the browser is known to run it
const missing = missingFeatures()
if (missing.length) showUnsupported(missing)
else import('./boot')
