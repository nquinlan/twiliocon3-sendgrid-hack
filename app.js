var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io').listen(server);
var fs = require('fs');
var mimelib = require("mimelib");
var crypto = require('crypto');
var mongoose = require('mongoose');

// Initialize SendGrid
var sendgrid = require('sendgrid')("YOUR_SENDGRID_USERNAME", "YOUR_SENDGRID_PASSWORD");
var Email = sendgrid.Email;

// Initialize Twilio
var twilio = require('twilio')('YOUR_TWILIO_SID', 'YOUR_TWILIO_TOKEN');

// Express Configurations!
app.configure(function(){
	app.set('port', process.env.PORT || 3000);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'hjs');
	app.use(express.favicon(__dirname + '/public/img/favicon.ico'));
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(app.router);
	app.use( express.static(__dirname + '/public') );
});


// Let's initialize all the Mongo Stuff!
mongoose.connect('mongodb://localhost/twiliocon');
var Schema = mongoose.Schema;

var PrizeSchema = new Schema({
	name: String,
	time: Date,
	winner: { type: mongoose.Schema.ObjectId, ref: 'Entry' }
});
var Prize = mongoose.model('Prize', PrizeSchema);

var EntrySchema = new Schema({
	email: String,
	hash: String,
	number: String,
	time: Date,
	won: { type: mongoose.Schema.ObjectId, ref: 'Prize' }
});
// Since Mongo does not (as of yet) support random querying let's implement it in Mongoose.
// From: http://stackoverflow.com/questions/14644545/random-document-from-a-collection-in-mongoose
EntrySchema.statics.random = function(callback) {
	this.count(function(err, count) {
		if (err) {
			return callback(err);
		}
		var rand = Math.floor(Math.random() * count);
		this.findOne().skip(rand).exec(callback);
	}.bind(this));
};

var Entry = mongoose.model('Entry', EntrySchema);

// Render the nice display page
app.get('/', function (req, res) {
	Entry.find({}).sort('-time').exec(function (err, entries) {
		var variables = {entries: entries};
		res.render('index', variables);
	});
});

// List all available drawings
app.get('/drawings.json', function (req, res) {
	Prize.find({ winner: null }).sort("time").exec(function (err, prizes) {
		res.send({ drawings : prizes });
	});
});

// SendGrid's Parse webhook will POST emails to whatever endpoint we tell it, so here we setup the endpoint /email.json
app.post('/email.json', function (req, res) {

	// Using Mimelib, let's determine the unqualified email address of the sender (e.g. nick@sendgrid.com not "Nick Quinlan (SendGrid)" <nick@sendgrid.com>)
	var addresses = mimelib.parseAddresses(req.body.from);
	var senderEmail = addresses[0].address.toLowerCase();

	// Get the phone number from the email

	// Taken from http://stackoverflow.com/a/123666/648494 - modified slightly
	var phoneNumberRegex = /(?:(?:\+?1\s*(?:[.-]\s*)?)?(?:\(\s*([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9])\s*\)|([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9]))\s*(?:[.-]\s*)?)?([2-9]1[02-9]|[2-9][02-9]1|[2-9][02-9]{2})\s*(?:[.-]\s*)?([0-9]{4})/g;
	var body = req.body.html || req.body.text;
	var numbers = body.match(phoneNumberRegex);

	// Now we pick the most likely number to send to
	// As the regex I grabbed isn't perfect for this scenario (and I don't hate myself enough to parse it)
	//   We're gonna do some checks

	for (var i = 0; i < numbers.length; i++) {
		// Get rid of all non-digits
		var number = numbers[i].replace(/[^\d]/g, "");
		
		// If the phone number is ten digits, let's add the 1
		// 'cause we're only going to allow people from the US to enter
		// (international restrictions and all that)
		if(number.length == 10){
			number = "1" + number;
		}

		// If there aren't enough digits, we can't send it to Twilio
		if(number.length == 11){
			// Let's go ahead and add the plus, so we can send it to Twilio
			number = "+" + number;
			break;
		}
		number = false;
	}

	if(!number) {
		// If we can't find a number ask the persn to try again.
		app.render('email/not-found', function(err, html){
			var notFoundEmail = {
				to: senderEmail,
				from: 'nick@sendgrid.com',
				fromname: 'Nick Quinlan (SendGrid)',
				replyto: 'enter@bymail.in',
				subject: 'I couldn’t find a phone number in your email.',
				html: html
			};
			sendgrid.send(notFoundEmail, function(err, resp) {
				res.send({"error" : "Email Not Found", response : resp});
			});
		});
	}else{

		// Make sure no one has already entered using the email or phone number supplied.
		Entry.findOne({ $or:[ {'email': senderEmail}, {'number': number} ] }, '_id', function (err, entry) {
			if(entry){

				// Respond that they've already entered
				app.render('email/already-entered', function(err, html){
					var alreadyEnteredEmail = {
						to: senderEmail,
						from: 'nick@sendgrid.com',
						fromname: 'Nick Quinlan (SendGrid)',
						subject: 'You’ve already entered!',
						html: html
					};
					sendgrid.send(alreadyEnteredEmail, function(err, resp) {
						res.send({"error" : "Already Entered", response : resp});
					});
				});

			}else{

				// Hash the email, so it can be used for a gravatar
				var hash = new crypto.createHash('md5');
				hash.update(senderEmail);

				var entryData = {
					'email' : senderEmail,
					'hash': hash.digest('hex'),
					'number': number,
					'time': new Date()
				};

				var entry = new Entry(entryData);

				// Save the entry so it can be drawn later
				entry.save(function (err) {
					// Report Any Errors
					if (err){
						app.render('email/error', function(err, html){
							var errorEmail = {
								to: senderEmail,
								from: 'nick@sendgrid.com',
								fromname: 'Nick Quinlan (SendGrid)',
								subject: 'An error occurred.',
								html: html
							};
							sendgrid.send(errorEmail, function(err, resp) {
								res.send({"error" : "Unknown", response : resp});
							});
						});
					}

					// Emit the information to the frontend
					res.send(entryData);
					io.sockets.emit('entry', entryData);
					
					// Render the thank you email & send it
					app.render('email/thanks', entryData, function(err, html){
						var thanksEmail = {
							to: senderEmail,
							from: 'nick@sendgrid.com',
							fromname: 'Nick Quinlan (SendGrid)',
							subject: 'Thanks for Entering the SendGrid Giveaway at TwiliCon',
							html: html
						};
						sendgrid.send(thanksEmail, function(err, resp) {
							// ...
						});
					});

					// Send the text message
					twilio.sendSms({
						to: number,
						from: 'YOUR_TWILIO_NUMBER',
						body: "Thanks for entering into the SendGrid Giveaways at Twiliocon! We'll text you at this number, if you win. Check your email for more info."
					}, function(err, resp) {
						// ...
					});

					res.send(entry);

				});


			}
		});

	}
});

app.get('/draw.json', function (req, res) {
	var currentTime = new Date();
	// Find all the prizes that should have been drawn by now, but haven't been
	Prize.find({ winner: null }).where('time').lt(currentTime).exec(function (err, prizes) {
		
		// The function that does all the assignment and notification.
		var drawPrize = function ( prize ) {
			Entry.random(function (err, entry) {
				prize.winner = entry._id;
				prize.save();

				entry.won = prize._id;
				entry.save();

				twilio.sendSms({
					to: entry.number,
					from: 'YOUR_TWILIO_NUMBER',
					body: "Congratulations, you won a SendGrid giveaway! Come to the SendGrid table in the Community Hall to claim your new " + prize.name + "!" 
				}, function(err, resp) {
					console.log(err);
				});	

				res.send({entry: entry, prize: prize});		
			});
		};

		// Loop through each prize and draw it
		for(var i = 0; i < 1; i++) {
			drawPrize(prizes[i]);
		}
	});
});

server.listen(app.get('port'), function(){
  console.log("Express server listening on port %d in %s mode", app.get('port'), app.settings.env);
});