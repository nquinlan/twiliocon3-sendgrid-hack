var socket = io.connect('/');
socket.on('entry', function (data) {
	console.log(data);
	$('<li style="display:none;"><img src="https://gravatar.com/avatar/' + data.hash + '?d=http%3A%2F%2Fd.pr%2Fi%2FaEL3%2B&s=100" alt=""></li>').prependTo("#who ul").show("fast");
});

setInterval(60000, function () {
	$.get('/draw.json', function () {

	});
});

$(function () {
	clock = $('#clock').FlipClock({ autostart: false, time: 60, callbacks : { stop: newCountdown } });
	
	$.get('/drawings.json', function ( data ) {
		drawings = data.drawings;
		// This just gets rid of an odity of the timer we're using.
		drawings.unshift({time : new Date()});
		newCountdown();
	});

});

function newCountdown () {
	var nextDrawing = drawings.shift();

	if(nextDrawing){

		var nextDrawingDate = (new Date(nextDrawing.time)) - (new Date());
		var nextDrawingDateSeconds = Math.floor( Number( nextDrawingDate )/1000);

		clock.setTime( nextDrawingDateSeconds );
		clock.setCountdown(true);
		clock.start();

	}
}