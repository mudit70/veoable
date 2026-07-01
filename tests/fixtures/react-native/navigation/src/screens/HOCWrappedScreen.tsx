// Fixture for #289: class component wrapped in HOCs (the very common
// react-redux pattern). The Screen registered with this component must
// resolve componentFunctionId to `HOCWrappedScreen.render`.
import React from 'react';
import { View, Text } from 'react-native';

declare const connect: (mapState?: unknown, mapDispatch?: unknown) => <T>(c: T) => T;

class HOCWrappedScreen extends React.Component {
  componentDidMount() {
    fetch('/api/players/1');
  }

  render() {
    return (
      <View>
        <Text>HOC-wrapped</Text>
      </View>
    );
  }
}

const mapStateToProps = (state: any) => ({ state });
const mapDispatchToProps = (dispatch: any) => ({ dispatch });

// curried connect — wraps the class. This is exactly musiccardapp's pattern.
export default connect(mapStateToProps, mapDispatchToProps)(HOCWrappedScreen);
