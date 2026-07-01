import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Link, useRouter } from 'expo-router';

export default function HomeTab() {
  const [items, setItems] = useState<any[]>([]);
  const router = useRouter();

  useEffect(() => {
    fetch('https://api.example.com/items')
      .then(res => res.json())
      .then(data => setItems(data));
  }, []);

  return (
    <View>
      <FlatList
        data={items}
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => router.push(`/items/${item.id}`)}>
            <Text>{item.name}</Text>
          </TouchableOpacity>
        )}
      />
      <Link href="/items/create">
        <Text>Create Item</Text>
      </Link>
    </View>
  );
}
