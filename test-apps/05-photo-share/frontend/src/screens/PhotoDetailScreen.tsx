import { useEffect, useState } from 'react';
import { Image, View, Text, Button, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { fetchPhoto, deletePhoto, type Photo } from '../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'PhotoDetail'>;

export default function PhotoDetailScreen({ route, navigation }: Props) {
  const [photo, setPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    fetchPhoto(route.params.photoId).then(setPhoto);
  }, [route.params.photoId]);

  if (!photo) return <ActivityIndicator />;

  async function handleDelete() {
    if (!photo) return;
    await deletePhoto(photo.id);
    navigation.goBack();
  }

  return (
    <View>
      <Image source={{ uri: photo.imageUrl }} style={{ width: '100%', height: 300 }} />
      <Text style={{ padding: 12 }}>{photo.caption}</Text>
      <Button title="Delete" onPress={handleDelete} />
    </View>
  );
}
