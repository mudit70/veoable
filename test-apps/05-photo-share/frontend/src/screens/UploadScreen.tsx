import { useState } from 'react';
import { Button, TextInput, View, Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { requestUploadUrl, uploadToS3, createPhoto } from '../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'Upload'>;

export default function UploadScreen({ navigation }: Props) {
  const [caption, setCaption] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  async function handleUpload() {
    setStatus('Requesting upload URL…');
    const { uploadUrl, s3Key } = await requestUploadUrl('image/jpeg');

    setStatus('Uploading to S3…');
    // In a real app you'd capture an image and PUT its bytes.
    const dummyBytes = new ArrayBuffer(1024);
    await uploadToS3(uploadUrl, dummyBytes);

    setStatus('Saving metadata…');
    await createPhoto({ s3Key, caption });

    setStatus('Done.');
    navigation.goBack();
  }

  return (
    <View style={{ padding: 16 }}>
      <TextInput
        value={caption}
        onChangeText={setCaption}
        placeholder="Caption"
        style={{ borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 12 }}
      />
      <Button title="Upload" onPress={handleUpload} />
      {status && <Text style={{ marginTop: 12 }}>{status}</Text>}
    </View>
  );
}
