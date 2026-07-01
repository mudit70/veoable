import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

export default function DetailScreen({ navigation, route }: any) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    fetch(`/api/songs/${route.params.id}`).then(r => r.json()).then(setDetail);
  }, [route.params.id]);

  const goToPlayer = () => {
    navigation.navigate('Player');
  };

  return (
    <View>
      <TouchableOpacity onPress={goToPlayer}>
        <Text>Play</Text>
      </TouchableOpacity>
    </View>
  );
}
