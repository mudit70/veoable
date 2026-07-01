import { Image, Pressable, Text, View } from 'react-native';
import type { Photo } from '../api/client';

interface Props {
  photo: Photo;
  onPress: () => void;
}

export default function PhotoCard({ photo, onPress }: Props) {
  return (
    <Pressable onPress={onPress}>
      <View style={{ marginBottom: 12 }}>
        <Image source={{ uri: photo.imageUrl }} style={{ width: '100%', height: 240 }} />
        <Text style={{ padding: 8 }}>{photo.caption}</Text>
      </View>
    </Pressable>
  );
}
