// Words ignored when extracting keywords and topics from speech.
const STOPWORDS = new Set((
  'about above after again against all also and any are because been before being below between both but can ' +
  'could did does doing down during each few for from further had has have having her here hers him his how ' +
  'into its itself just like more most need not off once only other our out over own same she should some ' +
  'such than that the their them then there these they this those through too under until very was were what ' +
  'when where which while who whom why will with would you your yours yeah okay thank thanks hello please ' +
  'right well know think want going gonna really actually something anything'
).split(' '));

module.exports = { STOPWORDS };
