import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore'
import { writeActivity } from './activity'
export const activityTable = onDocumentWrittenWithAuthContext({ document: 'restaurants/{rid}/locations/{lid}/tables/{tid}', region: 'europe-west1' }, event => writeActivity(event, 'table', event.params.tid))
