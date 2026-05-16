import crypto from 'crypto';

const S3_ENDPOINT   = process.env.S3_ENDPOINT   || 'https://s3.twcstorage.ru';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || '';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || '';
const S3_BUCKET     = process.env.S3_BUCKET     || 'miri-videos';
const S3_REGION     = process.env.S3_REGION     || 'ru-1';

export async function uploadBufferToS3(buffer, filename, mimetype) {
  const key  = filename;
  const host = new URL(S3_ENDPOINT).host;
  const now  = new Date();
  const date = now.toISOString().slice(0,10).replace(/-/g,'');
  const time = now.toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';

  const sign   = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const sha256 = d => crypto.createHash('sha256').update(typeof d === 'string' ? Buffer.from(d) : d).digest('hex');

  const payloadHash = sha256(buffer);
  const canonicalHeaders =
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + time + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT', '/' + S3_BUCKET + '/' + key, '',
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credScope  = date + '/' + S3_REGION + '/s3/aws4_request';
  const strToSign  = ['AWS4-HMAC-SHA256', time, credScope, sha256(canonicalRequest)].join('\n');
  const signingKey = sign(sign(sign(sign('AWS4' + S3_SECRET_KEY, date), S3_REGION), 's3'), 'aws4_request');
  const signature  = crypto.createHmac('sha256', signingKey).update(strToSign).digest('hex');
  const authHeader = 'AWS4-HMAC-SHA256 Credential=' + S3_ACCESS_KEY + '/' + credScope +
    ',SignedHeaders=' + signedHeaders + ',Signature=' + signature;

  const url = S3_ENDPOINT + '/' + S3_BUCKET + '/' + key;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': mimetype,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': time,
    },
    body: buffer,
  });

  if (!resp.ok) throw new Error('S3 error: ' + resp.status);
  return S3_ENDPOINT + '/' + S3_BUCKET + '/' + key;
}