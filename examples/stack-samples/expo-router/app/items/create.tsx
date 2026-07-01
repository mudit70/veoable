import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';

export default function CreateItem() {
  const router = useRouter();
  const [name, setName] = useState('');

  const handleCreate = async () => {
    await fetch('https://api.example.com/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    router.back();
  };

  return (
    <View>
      <TextInput value={name} onChangeText={setName} placeholder="Name" />
      <TouchableOpacity onPress={handleCreate}>
        <Text>Create</Text>
      </TouchableOpacity>
    </View>
  );
}
