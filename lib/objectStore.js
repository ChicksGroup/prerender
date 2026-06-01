// Thin wrapper over an S3-compatible object store (DigitalOcean Spaces / AWS S3)
// used by the redisCache plugin to hold rendered HTML bodies cheaply. Exposes a
// tiny { get, put } interface so the cache plugin stays decoupled from the SDK
// and can be unit-tested with an injected fake.
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  // aws-sdk v3 (Node) exposes this helper on the response body.
  if (typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function is404(err) {
  if (!err) return false;
  const code = err.$metadata && err.$metadata.httpStatusCode;
  return code === 404 || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey';
}

// opts: { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }
function createSpacesStore(opts) {
  const client = new S3Client({
    endpoint: opts.endpoint, // e.g. https://nyc3.digitaloceanspaces.com
    region: opts.region || 'us-east-1', // Spaces ignores it but the SDK requires one
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    forcePathStyle: !!opts.forcePathStyle,
  });
  const Bucket = opts.bucket;

  return {
    // meta: flat string->string map stored as object metadata.
    async put(key, buffer, meta) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: buffer,
          ContentType: 'text/html; charset=utf-8',
          ContentEncoding: 'gzip',
          Metadata: meta || {},
        }),
      );
    },

    // Best-effort delete (used to reap an expired 4xx body). A missing key is
    // not an error.
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    // Returns { body: Buffer, meta } or null if the object doesn't exist.
    async get(key) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket, Key: key }),
        );
        const body = await streamToBuffer(out.Body);
        return { body, meta: out.Metadata || {} };
      } catch (e) {
        if (is404(e)) return null;
        throw e;
      }
    },
  };
}

module.exports = { createSpacesStore, streamToBuffer, is404 };
