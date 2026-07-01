// #289 — HOC-wrapped FUNCTION component. Same connect() pattern but
// the wrapped target is a function component, not a class. Should
// resolve to the function itself (not <ClassName>.render).
import React from 'react';
import { View, Text } from 'react-native';

declare const connect: (mapState?: unknown) => <T>(c: T) => T;

function HOCWrappedFunctionScreen() {
  return (
    <View>
      <Text>HOC-wrapped function</Text>
    </View>
  );
}

const mapStateToProps = (state: any) => ({ state });

export default connect(mapStateToProps)(HOCWrappedFunctionScreen);
