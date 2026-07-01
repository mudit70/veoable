// Fixture for #267 — class-component screen registered as
// <Stack.Screen component={PlayerScreen}/>. Pre-fix this would emit
// a Screen with componentFunctionId: null.
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

export default class PlayerScreen extends React.Component<{ navigation: any }> {
  componentDidMount() {
    fetch('/api/songs/1');
  }

  handleBack = () => {
    this.props.navigation.goBack();
  };

  render() {
    return (
      <View>
        <Text>Player</Text>
        <TouchableOpacity onPress={this.handleBack}>
          <Text>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }
}
