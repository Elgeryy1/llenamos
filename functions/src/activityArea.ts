import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore'
import { writeActivity } from './activity'
export const activityArea = onDocumentWrittenWithAuthContext({ document: 'restaurants/{rid}/locations/{lid}/areas/{aid}', region: 'europe-west1' }, event => writeActivity(event, 'area', event.params.aid))
