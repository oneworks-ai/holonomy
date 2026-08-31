package ai.oneworks.holonomy.v86

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidV86ProcessEventsTest {
    @Test
    fun releasedChannelDiscardsLateProducerEventsWithoutReportingOverflow() {
        val channel = AndroidV86EventChannel(4)

        channel.close()

        assertTrue(channel.emit("late", 64))
    }

    @Test
    fun liveChannelReportsOnlyRealCapacityOverflow() {
        val channel = AndroidV86EventChannel(4)

        assertTrue(channel.emit("first", 4))
        assertFalse(channel.emit("overflow", 1))
    }
}
