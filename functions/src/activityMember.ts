import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore'
import { writeActivity } from './activity'
export const activityMember = onDocumentWrittenWithAuthContext({ document: 'restaurants/{rid}/members/{uid}', region: 'europe-west1' }, event => writeActivity(event, 'member', event.params.uid))
