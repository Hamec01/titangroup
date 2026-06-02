import { createHash } from 'node:crypto';

type CloudinaryUploadResult = {
  secure_url: string;
  public_id: string;
};

function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER || 'titangroup/services';

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary configuration is missing');
  }

  return { cloudName, apiKey, apiSecret, folder };
}

function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const paramString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return createHash('sha1').update(`${paramString}${apiSecret}`).digest('hex');
}

export async function uploadImageToCloudinary(file: File): Promise<{ url: string; publicId: string }> {
  const { cloudName, apiKey, apiSecret, folder } = getCloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = signParams({ folder, timestamp }, apiSecret);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('signature', signature);
  formData.append('folder', folder);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Cloudinary upload failed with status ${response.status}`);
  }

  const payload = (await response.json()) as CloudinaryUploadResult;

  if (!payload?.secure_url || !payload?.public_id) {
    throw new Error('Cloudinary upload response is invalid');
  }

  return {
    url: payload.secure_url,
    publicId: payload.public_id
  };
}

export async function deleteImageFromCloudinary(publicId: string): Promise<void> {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = signParams({ invalidate: 'true', public_id: publicId, timestamp }, apiSecret);

  const body = new URLSearchParams();
  body.set('public_id', publicId);
  body.set('api_key', apiKey);
  body.set('timestamp', String(timestamp));
  body.set('signature', signature);
  body.set('invalidate', 'true');

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Cloudinary delete failed with status ${response.status}`);
  }
}
