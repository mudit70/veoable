const BASE = process.env.API_URL ?? 'http://localhost:8000';

export interface Photo {
  id: string;
  caption: string;
  s3Key: string;
  imageUrl: string;
  uploaderId: string;
  createdAt: string;
}

export interface PresignedUpload {
  uploadUrl: string;
  s3Key: string;
}

export async function fetchFeed(): Promise<Photo[]> {
  const res = await fetch(`${BASE}/api/photos/`);
  if (!res.ok) throw new Error('feed failed');
  return res.json();
}

export async function fetchPhoto(id: string): Promise<Photo> {
  const res = await fetch(`${BASE}/api/photos/${id}`);
  if (!res.ok) throw new Error('photo failed');
  return res.json();
}

export async function requestUploadUrl(contentType: string): Promise<PresignedUpload> {
  const res = await fetch(`${BASE}/api/photos/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType }),
  });
  if (!res.ok) throw new Error('presign failed');
  return res.json();
}

export async function uploadToS3(uploadUrl: string, body: Blob | ArrayBuffer): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: body as any,
  });
  if (!res.ok) throw new Error('s3 upload failed');
}

export async function createPhoto(input: { s3Key: string; caption: string }): Promise<Photo> {
  const res = await fetch(`${BASE}/api/photos/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('create failed');
  return res.json();
}

export async function deletePhoto(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/photos/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed');
}
