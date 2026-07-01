import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function ItemDetail() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const [item, setItem] = useState<any>(null);

  useEffect(() => {
    fetch(`https://api.example.com/items/${id}`)
      .then(res => res.json())
      .then(data => setItem(data));
  }, [id]);

  const handleDelete = async () => {
    await fetch(`https://api.example.com/items/${id}`, { method: 'DELETE' });
    router.back();
  };

  return (
    <View>
      <Text>{item?.name}</Text>
      <TouchableOpacity onPress={handleDelete}>
        <Text>Delete</Text>
      </TouchableOpacity>
    </View>
  );
}
