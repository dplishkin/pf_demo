const socketioJwt = require('socketio-jwt');
const config = require('./config/database');
const mongoose = require('mongoose');

const User = require('./db/models/User.js');
const Deal = require('./db/models/Deal.js');
const Message = require('./db/models/Message.js');
const Attachment = require('./db/models/Attachment.js');

const Review = require('./db/models/Review.js');
const Notification = require('./db/models/Notification.js');

const Web3 = require('web3');
const web3 = new Web3(
    new Web3.providers.HttpProvider('https://ropsten.infura.io/')
);

// on client first call and on decision of prev escrow
const findEscrows = deal => {
    const used_ids = deal.escrows.map(escrow => escrow.escrow);
    return User.find({$and: [{type: 'escrow'}, {_id: {$nin: used_ids}}]});
};

const checkDispute = decisions => {
    if (decisions.length < 3) {
        return null;
    }
    let prev = null;
    let count = 0;
    for (let i = decisions.length - 1; i >= 0; i--) {
        if (decisions[i].decision === 'rejected') {
            continue;
        }
        if (!prev) {
            prev = decisions[i].decision;
            continue;
        }
        if (decisions[i].decision === prev) {
            count++;
            if (count === 2) {
                return prev;
            }
        } else {
            return null;
        }
    }
};

const checkNotifications = (deal, user) => {
    return new Promise((resolve, reject) => {
        Notification
            .find({
                user: user,
                deal: deal,
                type: 'message'
            })
            .remove()
            .then(notifications => {
                return Notification
                    .aggregate([
                        {
                            $match: {
                                $and: [
                                    {type: 'message'},
                                    {user: mongoose.Types.ObjectId(user)}
                                ]
                            }
                        },
                        {
                            $group: {
                                _id: '$deal',
                                notifications: {
                                    $sum: 1
                                },
                                created_at: {
                                    $max: '$created_at'
                                }
                            }
                        },
                        {
                            $lookup: {
                                from: 'deals',
                                localField: '_id',
                                foreignField: '_id',
                                as: 'deal'
                            }
                        },
                        {
                            $unwind: '$deal'
                        },
                        {
                            $project: {
                                _id: 0,
                                created_at: 1,
                                deal: 1,
                                notifications: 1,
                                type: 'message'
                            }
                        }
                    ])
            .then(notifications => {
                return Notification
                    .update({user: user, deal: deal, viewed: false}, {$set: {viewed: true}}, {multi: true})
                    .then(_notifications => {
                        return Notification
                            .find({
                                $and: [
                                    {
                                        type: {
                                            $ne: 'message'
                                        }
                                    },
                                    {
                                        user: user
                                    }
                                ]
                            })
                            .populate('sender', 'username')
                            .populate({path: 'deal', populate: [{path: 'exchange', select: ['tradeType']}]});
                    })
                    .then(_notifications => {
                        for (let i = 0; i < notifications.length; i++) {
                            _notifications.push(notifications[i]);
                        }
                        
                        _notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                        resolve(_notifications);
                    })
                    .catch(err => {
                        reject(err);
                    });
                });
            })
            .catch(err => {
                reject(err);
            })
    });
};

const checkUserInRoom = (clients, room) => {
    for (let client of clients) {
        if (room[client]) {
            return true;
        }
    }
    return false;
};

const getUsersFromRoom = (clients, room) => {
    let result = [];
    for (let client in room) {
        for (let c in clients) {
            if (clients[c].indexOf(client) != -1 && result.indexOf(c) == -1) {
                result.push(c);
            }
        }
    }
    return result;
};

const createAndSendNotification = async (notification, io) => {
    notification = await new Notification(notification).save(); // create notification
    notification = await Notification // get notification with populate deal and sender
        .findById(notification._id)
        .populate('deal')
        .populate('sender', 'username');

    const clients = io.clients[notification.user];
    if (clients) {
        for (let client of clients) {
            io.to(client).emit('notification', notification); // send notification to all clients (tabs)
        }
    }
};

module.exports = (server, app) => {
    const io = require('socket.io')(server);

    const clients = {};
    app.io = io;
    io.clients = clients;
    
    io.on('connection', socketioJwt.authorize({
        secret: config.secret,
    })).on('authenticated', client => {
        client.emit('authorized');

        if (!clients[client.decoded_token._id]) {
            clients[client.decoded_token._id] = [];
        }
        clients[client.decoded_token._id].push(client.id);

        User
            .findById(client.decoded_token._id)
            .then(doc => {
                if (doc) {
                    doc.online.status = true;
                    doc.online.lastConnect = new Date();
                    return doc.save();
                }
            }).then().catch(err => {console.log('Online status error:', err)});

        // attachments in chats
        require('./socket/uploads')(client);

        // message, accept_*, set_* in deal
        require('./socket/client')(client, io);

        require('./socket/dispute')(client, io);

        client.on('join_chat',  data => {
            Deal.findOne({dId: data.deal_id}).populate({path: 'messages', populate: [{path: 'sender', select: ['_id', 'username']}, {path: 'attachments'}]})
                .populate({path: 'seller', select: ['_id', 'username']})
                .populate({path: 'buyer', select: ['_id', 'username']})
                .populate({path: 'exchange', select: 'limits'})
                .then (deal => {
                    if (!deal) {
                        return;
                    }
                    let role = deal.getUserRole(client.decoded_token._id);

                    if (role) {
                        if (role === 'escrow') {
                            let escIndex = 0;
                            deal.escrows.forEach((esc, index) => {
                                if (esc.escrow.toString() === client.decoded_token._id.toString()) {
                                    escIndex = index;
                                }
                            });
                            let tmp = Object.assign({}, deal._doc);
                            tmp.decision = deal.escrows[escIndex].decision ? deal.escrows[escIndex].decision : 'pending';
                            delete tmp.escrows;
                            client.emit('initMessages', {
                                deal: tmp,
                                messages: deal.messages
                            });

                            //need to set 'join_at' value to escrow
                            deal.escrows[escIndex].join_at = new Date();
                            deal.save().then().catch(err => {console.log(err)});
                        } else {
                            if (deal.status === 'completed'){
                                Review.find({deal: deal._id, author: client.decoded_token._id}).then(doc => {
                                    let can_review = false;
                                    if (!doc.length){
                                        can_review = true;
                                    }

                                    client.emit('initMessages', {
                                        deal: deal,
                                        messages: deal.messages,
                                        counterparty: (role === 'seller' ? deal.buyer : deal.seller),
                                        can_review: can_review
                                    });
                                });
                            } else {
                                client.emit('initMessages', {
                                    deal: deal,
                                    messages: deal.messages,
                                    counterparty: (role === 'seller' ? deal.buyer : deal.seller)
                                });
                            }
                        }
                        client.join(deal._id.toString());
                        return deal;
                    }
                })
                .then(deal => {
                    if (deal) {
                        Message.update({deal: deal._id}, {$addToSet: {viewed: client.decoded_token._id}}, {multi: true}).then();
                        checkNotifications(deal._id, client.decoded_token._id).then(notifications => {
                            client.emit('notifications', notifications);
                        });
                    }
                })
                .catch(err => {
                    console.log(err);
                });
        });

        client.on('leave_chat', data => {
            Deal.findOne({dId: data.deal_id})
                .then(deal => {
                    client.leave(deal._id);
                });
        });

        client.on('logout', () => {
            const logoutClients = clients[client.decoded_token._id];
            console.log('logoutClients', logoutClients);
            if (logoutClients) {
                for (let id of logoutClients) {
                    io.to(id).emit('refresh');
                }

            }
        });

        client.on('disconnect', () => {
            if (clients[client.decoded_token._id].length > 1 && clients[client.decoded_token._id].indexOf(client.id) != -1) {
                let index = clients[client.decoded_token._id].indexOf(client.id);
                clients[client.decoded_token._id].splice(index, 1);
            } else {
                delete clients[client.decoded_token._id];
                User
                    .findById(client.decoded_token._id)
                    .then(doc => {
                        if (doc) {
                            doc.online.status = false;
                            return doc.save();
                        }
                    }).then().catch(err => {console.log('Online status error:', err)});
            }
        });
    });

    return io;
};