import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text } from 'react-native';

export default function CreateUserScreen({ navigation }: any) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = async () => {
    await fetch('https://api.example.com/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    navigation.goBack();
  };

  return (
    <View>
      <TextInput value={name} onChangeText={setName} placeholder="Name" />
      <TextInput value={email} onChangeText={setEmail} placeholder="Email" />
      <TouchableOpacity onPress={handleSubmit}>
        <Text>Create</Text>
      </TouchableOpacity>
    </View>
  );
}
