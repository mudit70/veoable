import { useEffect, useState } from 'react';
import { Button, FlatList, View, RefreshControl } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { fetchFeed, type Photo } from '../api/client';
import PhotoCard from '../components/PhotoCard';

type Props = NativeStackScreenProps<RootStackParamList, 'Feed'>;

export default function FeedScreen({ navigation }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      setPhotos(await fetchFeed());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <Button title="Upload" onPress={() => navigation.navigate('Upload')} />
      <FlatList
        data={photos}
        keyExtractor={(p) => p.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item }) => (
          <PhotoCard
            photo={item}
            onPress={() => navigation.navigate('PhotoDetail', { photoId: item.id })}
          />
        )}
      />
    </View>
  );
}
