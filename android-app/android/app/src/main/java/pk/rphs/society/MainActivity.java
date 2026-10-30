package pk.rphs.society;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RphsBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
