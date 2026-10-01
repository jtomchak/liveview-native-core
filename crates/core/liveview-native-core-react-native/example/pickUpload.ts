import * as DocumentPicker from 'expo-document-picker';

/** Files remain local cache URIs; native code reads their bytes without JS base64. */
export async function pickUpload() {
  const result = await DocumentPicker.getDocumentAsync({ type: ['image/png', 'text/plain'], multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const mimeType = !asset.mimeType || asset.mimeType === 'application/octet-stream'
    ? (/\.png$/i.test(asset.name) ? 'image/png' : /\.txt$/i.test(asset.name) ? 'text/plain' : 'application/octet-stream')
    : asset.mimeType;
  return { uri: asset.uri, name: asset.name, mimeType, size: asset.size };
}
