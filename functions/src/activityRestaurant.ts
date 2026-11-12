import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore'
import { writeActivity } from './activity'
export const activityRestaurant = onDocumentWrittenWithAuthContext({ document: 'restaurants/{rid}', region: 'europe-west1' }, event => writeActivity(event, 'restaurant', event.params.rid))
